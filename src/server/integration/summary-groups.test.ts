// Phase ①'s GROUP pipeline, end to end through the REAL server: the real workspace books, the real
// coordinator and engine sweeps, the §8 tool catalogue, and the scripted crew of `./harness.ts`
// answering from its brief (documents/phase-1-research-pipeline.md §6.4 as R5 reshaped it).
//
// WHAT THIS FILE IS FOR, as distinct from the unit files beside it:
//
//   `loop/phase1-groups.test.ts`     — the batch, the seats, the cap, and R3's closure against a SEEDED
//                                      approved finding and task, where the ordering is the test's;
//   `run/phase1-prompt.test.ts`      — the exact bytes of the two compiled group turns;
//   `loop/phase1-groups-restart.test.ts` — what a restart and a lapsed lease recover;
//   THIS FILE                      — the pipeline nobody can seed: the defect is FILED by the deep
//                                      review's tool call, APPROVED by the Editor's, and answered by a
//                                      batch the loop cut by itself. Nothing here is handed to the
//                                      engine; every id, revision and state below was produced by the
//                                      Story's own sweep sequence.
//
// WHY THE ORDERING IS THE SUBJECT. In this pipeline the Writer batch is planned off an OPEN finding
// (`loop/work.ts:groupWorkTargets` takes D-33's `unconfirmed`/`confirmed` rows deliberately), so the
// fix lands BEFORE the approval in the ordinary case — and R3's close refuses an unapproved row
// (`phrase/findings.ts:closeFindingWhenGroupsResolved`'s state gate, D-34). The install-time close
// therefore declines almost ALWAYS on a group book, and what closes the finding one sweep later is the
// reconciliation at `loop/engine.ts`'s `loop_reconcile_findings` commit. Pinned below: the finding
// reads `approved` with its whole debt already paid — every group it names carries a resolving revision —
// and `fixed`, with the fix task consumed, on the sweep that reconciliation runs.
//
// WHAT D-66 TOOK AWAY, and it is the reason the second case reads the way it does. A defect naming TWO
// groups on a book whose batch dial is 1 used to be TWO passes, and this file was the only place that
// could read the moment between them: premise at number 2, ending at number 1, `owed_by_findings` on one
// group and not the other. The dial caps BATCHES, not DEFECTS, so the pair goes out as one pass
// (`phrase/exclusion.ts:planGroupDraftBatch`) and that half-answered state no longer exists on a Story the
// loop drives. What the second case pins instead is the shape of the single pass: one Run row over both
// groups under the SET's claim key, two number-2 Group Revisions naming that same run and the same
// `finding_refs`, and no second attempt anywhere in the family.
//
// WHAT IS PINNED AS A NUMBER AND WHY IT MAY BE ONE: the Story's `phrase_groups.id`s are real UUIDs
// issued per boot, so every claim key below is RECOMPUTED from the store's rows through the same
// `groupVectorHash` the planner uses — no hash is hardcoded. Run ids (`run_2`, `run_7`) are
// creation-ordered and stable, and dispatch is one run per sweep (the S-5 ceiling's default), which is
// what makes the mid-state of the second case reachable at all. D-65's scoring pass is one of those
// runs: it takes the slot immediately after each install that completes the Overview, so every id after
// the first score row is one higher than it was before that decision. The ids are pinned, not derived,
// precisely so that a seat which quietly stopped running — or a scoring pass that started gating sign-off
// — shows up here as a hole in the ledger.
import { describe, expect, it } from 'vitest';
import {
    bootStoryline,
    createSliceStory,
    crewRows,
    SLICE_SEED,
    storyRow,
    type StorylineFixture
} from './harness';
import { groupVectorHash } from '../phrase/revisions';
import type { Store } from '../store/store';
import { seedHashOf } from '../../shared/seed-hash';
import { PHRASE_GROUP_KEYS, phraseGroupRank } from '../../shared/phrase';

/** The Editor's structuring pass — the loop's first claim on any Story, group-managed or not. */
const STRUCTURE_KEY = `wi_structure_seed_${seedHashOf(SLICE_SEED)}`;

/** §6.4 steps 1-2: the two priority-0 gates, in dispatch order. */
const GATE_LINES = [
    `${STRUCTURE_KEY}[editor-seed-structure/editor]=torn_down`,
    'wi_research_1[researcher-story/researcher]=torn_down'
];

/** Every run row as `claim key[template/role]=state`, in dispatch order. */
const runLines = async (fixture: StorylineFixture, storyId: string): Promise<string[]> =>
    (await crewRows(fixture, storyId)).map((row) => `${row.work_item_ref}[${row.template_ref}/${row.role}]=${row.state}`);

/** The Story's group rows, CATALOG order — the order every batch, prompt and projection uses (R1). */
const groupsOf = (fixture: StorylineFixture, storyId: string) =>
    fixture.store.phraseGroups
        .list()
        .filter((row) => row.story_id === storyId)
        .sort((left, right) => phraseGroupRank(left.key) - phraseGroupRank(right.key));

/**
 * The ids behind catalog keys, read from a Store the CALLER can already answer for. The crew's helper
 * takes `ctx.store` — `harness.ts` hands each session the book of the Story its brief quotes — because
 * `fixture.store` is an ACCESSOR that answers the app-config book until the Story's own book has been
 * opened, and a crew that reaches for it during the first sweeps reads an empty phrase table.
 */
const groupIdsIn = (store: Store, storyId: string, keys: readonly string[]): string[] =>
    keys.flatMap((key) =>
        store.phraseGroups
            .list()
            .filter((row) => row.story_id === storyId && row.key === key)
            .map((row) => row.id)
    );

const groupIdOf = (fixture: StorylineFixture, storyId: string, key: string): string =>
    groupsOf(fixture, storyId).find((row) => row.key === key)!.id;

/** The ids behind a list of catalog keys, in catalog order. */
const idsOf = (fixture: StorylineFixture, storyId: string, keys: readonly string[]): string[] =>
    keys.map((key) => groupIdOf(fixture, storyId, key));

/**
 * The `draft_groups` claim FAMILY for a batch over these groups: `loop/work.ts` hashes the group SET
 * with every revision pinned at 0, so the first draft of a group and the FIX of that same group share
 * one family and differ only in the attempt number — which is what makes "one lapse, one replacement"
 * and "one defect, one retry per group" readable in the ledger.
 */
const draftFamily = (fixture: StorylineFixture, storyId: string, keys: readonly string[]): string =>
    `wi_draft_groups_summary_0_${groupVectorHash(
        Object.fromEntries(idsOf(fixture, storyId, keys).map((id) => [id, 0]))
    )}`;

/**
 * The `review_groups` seat / `group_check` claim for the vector these keys are AT the given revision.
 * R5 replaced "screen N candidates" with "read the installed Overview at one vector", so the vector —
 * not a draft id — is the claim's identity.
 *
 * D-65's scoring seat is keyed the same way (one `wi_summary_score_<vector>` claim per vector, no pass
 * number), and it is returned here for the same reason the two seats are: the hash is recomputed from
 * the group ids and revisions the book holds, never copied off a run.
 */
const vectorFamily = (
    fixture: StorylineFixture,
    storyId: string,
    keys: readonly string[],
    revisions: Record<string, number>
): { seat: string; check: string; score: string; hash: string } => {
    const hash = groupVectorHash(
        Object.fromEntries(keys.map((key) => [groupIdOf(fixture, storyId, key), revisions[key]]))
    );

    return {
        seat: `wi_review_groups_${hash}`,
        check: `wi_group_check_${hash}`,
        score: `wi_summary_score_${hash}`,
        hash
    };
};

/** Every key at one revision — the shape a freshly-written Overview's vector has. */
const atRevision = (keys: readonly string[], revision: number): Record<string, number> =>
    Object.fromEntries(keys.map((key) => [key, revision]));

/** The five catalog keys, in order. */
const ALL_KEYS = [...PHRASE_GROUP_KEYS];

/** The mock crew's `GroupDraft` answer, per group: `<key>: <the Seed's logline>` (`harness.ts`). */
const defaultGroupContent = (fixture: StorylineFixture, key: string): string =>
    `${key}: ${fixture.store.seedBriefs.list()[0]!.logline}`;

describe('the group pipeline end to end: the defect is filed, approved, and answered group by group', () => {
    it('writes all five groups in one batch, files a premise defect, and closes it once premise is rewritten', async () => {
        // The batch dial at 5 means the first Writer pass covers the whole Overview at once (R5's
        // "one structured pass", not N competing samples), and the fix pass may still address one group.
        const fixture = await bootStoryline({
            criticIdeas: 0,
            // R3: the deep review's finding carries `group_refs`, and the Reader REFUSES a phase-①
            // Summary defect that names no group on a group book. One group is the case the routing
            // exists for: the fix batch is cut against premise alone.
            criticGroupRefs: (ctx) => groupIdsIn(ctx.store, ctx.story?.id ?? '', ['premise']),
            // The defect is a ONE-ROUND event: as soon as premise carries a second revision the scripted
            // review is clean, so the loop stops at the sign-off instead of grinding to the attempt cap.
            criticFinds: (ctx) => {
                const premise = ctx.store.phraseGroups.list().find((row) => row.story_id === ctx.story?.id && row.key === 'premise');

                return premise !== undefined && premise.revision >= 2 ? undefined : 'critical';
            }
        });

        const storyId = await createSliceStory(fixture, 1, { mode: 'groups', sampling: 5, critics: 1 });

        try {
            await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 60);

            const logline = fixture.store.seedBriefs.list()[0]!.logline;
            const firstVector = vectorFamily(fixture, storyId, ALL_KEYS, atRevision(ALL_KEYS, 1));

            // THE LEDGER, in dispatch order, and nothing else: gates → one pass over five groups → the
            // Reader scoring that installed Overview → the seat over the installed Overview → the deep
            // review that FILES the defect → the Editor's verification that APPROVES it → the fix pass
            // over premise → the scoring pass for the NEW vector → the seat and the deep review of that
            // vector. There is no `wi_sample_` claim and no selection step anywhere (R5 removed them from
            // this path).
            //
            // The two `wi_summary_score_` lines are D-65: one Reader pass per group vector, ranked ahead
            // of the Critic seats so the score describes the text while it is the installed one. It
            // neither spends a group's Writer allowance nor holds sign-off — the list still ends at the
            // seats the gate counts, and the sweep still parks at `phase_signoff` after them.
            //
            // The two lines after the fix are the hardening: the fix installed a new group vector, and a
            // vector's Critic seats are owed until they report. Before this pass the sweep handed the
            // Author the lock over the rewritten Overview WITHOUT reading it (the sign-off's only review
            // read was the legacy `deepReviewPassesOwed(selectedSummaryRevision)`, which is vacuous on a
            // book that has no selected Summary revision) — which is both the sign-off defect and the
            // reason the ledger used to stop at the fix. It now pays the seats first, and only then parks
            // at the sign-off (`status.ts:decideStory`'s grouped `reviewOwed` branch).
            const secondVector = vectorFamily(fixture, storyId, ALL_KEYS, { ...atRevision(ALL_KEYS, 1), premise: 2 });

            await expect(runLines(fixture, storyId)).resolves.toEqual([
                ...GATE_LINES,
                `${draftFamily(fixture, storyId, ALL_KEYS)}_1[writer-summary-sampler/writer]=torn_down`,
                // D-67: no `wi_summary_score_…` row anywhere in this ledger. The deep pass files a premise
                // defect on the first vector (and on the second), so the Selection never becomes complete,
                // and the Reader is never offered a Summary the crew is still rejecting. The scoring pass
                // itself — its gate, its rank, its refusal re-arm — is pinned in `loop/section-scores.test.ts`.
                `${firstVector.seat}_1[critic-screening/critic]=torn_down`,
                `${firstVector.check}_1[critic-genre/critic]=torn_down`,
                'wi_verify_finding_finding_0_1[editor-general/editor]=torn_down',
                `${draftFamily(fixture, storyId, ['premise'])}_1[writer-summary-sampler/writer]=torn_down`,
                `${secondVector.seat}_1[critic-screening/critic]=torn_down`,
                `${secondVector.check}_1[critic-genre/critic]=torn_down`
            ]);

            const groups = groupsOf(fixture, storyId);

            // ONLY premise moved, and it moved to its OWN next number (R2). The four siblings keep
            // number 1 and the run that wrote them, and none of them was rewritten to answer a defect
            // nobody attributed to it. The fix's run id is `run_6` rather than the `run_7` it was under
            // D-65: the scoring pass no longer opens a row in this ledger (no Clean verdict on a vector
            // whose deep review filed a finding), so every id downstream of the first draft batch is one
            // lower — the same shift the run ledger above pins.
            expect(groups.map((row) => [row.key, row.revision, row.updated_by])).toEqual([
                ['premise', 2, 'run_6'],
                ['promise', 1, 'run_2'],
                ['theme', 1, 'run_2'],
                ['tone', 1, 'run_2'],
                ['ending', 1, 'run_2']
            ]);

            // The installed text is the PROMPT's own answer: the mock crew writes `<key>: <logline>`, so
            // a group provably came from the batch that named it. The fix did not change premise's prose
            // because the cooperative crew answers both turns from the same Seed — what the fix produced
            // is the revision ROW and the closure, which is the part R2/R3 are about.
            expect(groups.map((row) => row.content)).toEqual(ALL_KEYS.map((key) => defaultGroupContent(fixture, key)));
            expect(logline.length).toBeGreaterThan(0);

            // THE REVISION HISTORY (R2): five rows for the first pass, then premise's number 2 as the new
            // `latest` with number 1 ARCHIVED AND RETAINED. The new row carries the finding it was written
            // for and no task — the batch was planned before the approval created the task, which is the
            // ordering the header describes.
            expect(
                fixture.store.groupRevisions
                    .list()
                    .map((row) => [row.id, row.group_key, row.number, row.state, row.run_ref, row.finding_refs, row.task_refs])
            ).toEqual([
                ['group_revision_0', 'premise', 1, 'archived', 'run_2', undefined, undefined],
                ['group_revision_1', 'promise', 1, 'latest', 'run_2', undefined, undefined],
                ['group_revision_2', 'theme', 1, 'latest', 'run_2', undefined, undefined],
                ['group_revision_3', 'tone', 1, 'latest', 'run_2', undefined, undefined],
                ['group_revision_4', 'ending', 1, 'latest', 'run_2', undefined, undefined],
                ['group_revision_5', 'premise', 2, 'latest', 'run_6', ['finding_0'], undefined]
            ]);

            // R3: `fixed`, not "approved and assumed done" — and closed on the join, because premise is
            // the only group it names and premise has a revision claiming to resolve it.
            const finding = fixture.store.findings.require('finding_0');

            expect({
                state: finding.state,
                cost: finding.cost,
                target_ref: finding.target_ref,
                criterion_ref: finding.criterion_ref,
                group_refs: finding.group_refs,
                approved_by: finding.approved_by,
                seen_count: finding.seen_count
            }).toEqual({
                state: 'fixed',
                cost: 'critical',
                target_ref: 'summary_0',
                criterion_ref: 'C-14',
                group_refs: [groupIdOf(fixture, storyId, 'premise')],
                approved_by: 'auto',
                seen_count: 1
            });

            // D-34's task, consumed by the same evidence rule `settleJob` applies beside an install.
            // `attempts: 0` is not a contradiction: the row was armed AFTER the pass that answered it, so
            // it was never dispatched, and the sweep closed it rather than spending a run on it.
            expect(
                fixture.store.tasks.list().map((row) => [row.id, row.kind, row.state, row.finding_ref, row.attempts, row.rev])
            ).toEqual([['task_0', 'fix', 'done', 'finding_0', 0, 2]]);

            // R5's review product: one structured seat per VECTOR that ever existed over this Overview —
            // the first vector's seat (which produced the deep review's finding) and the fix's NEW vector's
            // seat, both valid with nothing to report (`criticFinds` goes clean once premise is at 2). The
            // second row is the hardening: the sign-off no longer walks past an unread vector.
            expect(fixture.store.sampleReviews.list().map((row) => [row.id, row.valid, row.issues.length])).toEqual([
                ['sample_review_0', true, 0],
                ['sample_review_1', true, 0]
            ]);
            // The deep review's verdicts, one per vector too: `run_4` read the first Overview and filed the
            // premise defect; `run_8` read the REWRITTEN one and advanced it — the evidence the sign-off
            // this test settles on now waits for. D-67 moved both ids down (one, then two): the scoring
            // pass takes NO Run row on a vector nobody stamped clean, and the slot it used to occupy ahead of
            // each vector's seats is what pushed the later ids up under D-65.
            expect(fixture.store.verdicts.list().map((row) => [row.id, row.target_ref, row.recommendation, row.run_ref])).toEqual([
                ['verdict_0', 'summary_0', 'advance', 'run_4'],
                ['verdict_1', 'summary_0', 'advance', 'run_8']
            ]);

            // R6's mirror, in the SAME commit as the install: the legacy prose fields carry the groups,
            // so a `readSummary` caller still sees a coherent Overview after the redesign.
            const summary = fixture.store.summaries.require('summary_0');

            expect(
                ALL_KEYS.map((key) => [key, (summary as unknown as Record<string, string>)[key]])
            ).toEqual(ALL_KEYS.map((key) => [key, defaultGroupContent(fixture, key)]));

            // THE AUTHOR'S READ (`GET …/phrases`). Every flag is false because the loop is stopped and
            // nothing is owed: `writer_busy` is derived from LIVE holding runs, so it clears the moment a
            // pass closes, and `owed_by_findings` is empty because the finding is `fixed`.
            const view = await fixture.api<any>('GET', `/stories/${storyId}/phrases`);

            expect(view.status).toBe(200);
            expect((view.body.groups as any[]).map((row) => [row.key, row.revision, row.writer_busy, row.owed_by_findings])).toEqual([
                ['premise', 2, false, []],
                ['promise', 1, false, []],
                ['theme', 1, false, []],
                ['tone', 1, false, []],
                ['ending', 1, false, []]
            ]);
            expect((view.body.groups as any[]).map((row) => row.history.map((entry: any) => [entry.number, entry.state, entry.run_ref, entry.finding_refs]))).toEqual([
                [
                    [2, 'latest', 'run_6', ['finding_0']],
                    [1, 'archived', 'run_2', []]
                ],
                [[1, 'latest', 'run_2', []]],
                [[1, 'latest', 'run_2', []]],
                [[1, 'latest', 'run_2', []]],
                [[1, 'latest', 'run_2', []]]
            ]);

            // D-65 ON THE AUTHOR'S READ — D-67 then moved the rail's SOURCE. `scores` is still the pinned
            // wire field (`api/projections.ts:PhraseGroupScoreRow`), but the pass now answers for the
            // compiled REVIEWED vector only, and nothing in this book is a reviewed selection: premise's
            // fix left an OPEN finding on its own vector, so no Clean stamp exists, the selection is
            // incomplete, and no score pass runs at all. Hence an empty rail on every group — which is
            // itself the proof that the gate holds (a row here would mean a vector had been scored that
            // no cross-group pass ever blessed). `loop/section-scores.test.ts` owns the pass firing, and
            // `api/phrase-routes.test.ts` ("Reviewed Summary on the wire") owns the populated rail.
            expect((view.body.groups as any[]).map((row) => [row.key, row.scores])).toEqual([
                ['premise', []],
                ['promise', []],
                ['theme', []],
                ['tone', []],
                ['ending', []]
            ]);

            // The rail carries the CLOSED finding with its join computed — `resolved_all: true` and an
            // empty `missing` are the proof the Author reads, not a debt. The `done` task is not part of
            // the queue the rail lists.
            expect(
                (view.body.findings as any[]).map((row) => [row.id, row.state, row.resolved_all, row.group_refs, row.resolved, row.missing])
            ).toEqual([['finding_0', 'fixed', true, [groupIdOf(fixture, storyId, 'premise')], [groupIdOf(fixture, storyId, 'premise')], []]]);
            expect(view.body.tasks).toEqual([]);
            expect({
                mode: view.body.review.mode,
                written_groups: view.body.review.written_groups,
                unwritten_groups: view.body.review.unwritten_groups,
                review_seats: view.body.review.review_seats,
                open_findings: view.body.review.open_findings,
                blocking_findings: view.body.review.blocking_findings,
                open_tasks: view.body.review.open_tasks,
                mirror: { summary_id: view.body.review.mirror.summary_id, in_sync: view.body.review.mirror.in_sync, locked: view.body.review.mirror.locked }
            }).toEqual({
                mode: 'groups',
                written_groups: 5,
                unwritten_groups: [],
                review_seats: 1,
                open_findings: 0,
                blocking_findings: 0,
                open_tasks: 0,
                mirror: { summary_id: 'summary_0', in_sync: true, locked: false }
            });

            // The loop STOPPED rather than spun: nothing is owed, so the Story asks for the sign-off, and
            // the crew took no further action after the fix (the ledger above is the whole story).
            expect(await storyRow(fixture, storyId)).toMatchObject({
                phase: 'summary',
                status: 'pending',
                pending_kind: 'phase_signoff',
                status_reason: `phase summary's Goal passes (2/2) · the Summary awaits your lock · the Ideas tray is empty · the crew is stopped until you act (L-29)`,
                blocked_on: 'the Summary',
                levels: { summary: '2/2' }
            });

            // And the pipeline got there without a single tool refusal — including the Reader's group
            // attribution rule, which the deep review satisfied by naming `group_refs` (R3).
            expect(fixture.refusals).toEqual([]);
        } finally {
            await fixture.close();
        }
    });

    it('answers a two-group defect in ONE pass over BOTH groups, then closes it and spends the task', async () => {
        // The batch dial at ONE, and a defect naming premise AND ending. Before D-66 that pair was two
        // batches, and the slice below used to read the book in the middle of it — premise rewritten, ending
        // still wrong, the finding `approved` and open. D-66 removes that moment: the dial caps BATCHES, not
        // DEFECTS, so the pair goes out as one pass and the Author's book never shows the defect half
        // answered. R3's join is still what closes the row (phrase/findings.ts), but the partial state this
        // test used to pin is no longer a state the loop can reach.
        const fixture = await bootStoryline({
            criticIdeas: 0,
            criticGroupRefs: (ctx) => groupIdsIn(ctx.store, ctx.story?.id ?? '', ['premise', 'ending']),
            // The defect clears once the FIRST named group has its second revision; the loop still owes
            // the second one, and the finding may not close until the second lands.
            criticFinds: (ctx) => {
                const premise = ctx.store.phraseGroups.list().find((row) => row.story_id === ctx.story?.id && row.key === 'premise');

                return premise !== undefined && premise.revision >= 2 ? undefined : 'critical';
            }
        });

        const storyId = await createSliceStory(fixture, 1, { mode: 'groups', sampling: 1, critics: 1 });

        try {
            await fixture.settle(() => groupsOf(fixture, storyId).some((row) => row.key === 'premise' && row.revision >= 2), 40);

            const premise = groupIdOf(fixture, storyId, 'premise');
            const ending = groupIdOf(fixture, storyId, 'ending');

            // ONE GROUP AT A TIME for the first drafts, in catalog order — and then the fix, which is NOT
            // one group at a time: the pair goes out together. Each first draft is the family for one group;
            // the fix pass is the family for the SET the finding named, at its own attempt 1, because no
            // pass has ever claimed `{premise, ending}` before (`loop/work.ts:planGroupDraftBatch`).
            //
            // The row ids are the store's own counter, and D-67 is the only reason they are not all one
            // higher than the draft ids: the scoring pass opens NO Run row in this rig, because the deep
            // cross-group review files a finding on the fifth install and a group with an unresolved defect
            // never carries a Clean verdict (`phrase/reviewed.ts:cleanSelectionOf` is the seat's gate). The
            // five first-draft ids are untouched either way: a half-written Overview has no selection at all.
            expect(
                fixture.store.runs
                    .list()
                    .filter((row) => (row.work_item_ref ?? '').startsWith('wi_draft_groups'))
                    .map((row) => [row.id, row.work_item_ref, (row.group_refs ?? []).length])
            ).toEqual([
                ['run_2', `${draftFamily(fixture, storyId, ['premise'])}_1`, 1],
                ['run_3', `${draftFamily(fixture, storyId, ['promise'])}_1`, 1],
                ['run_5', `${draftFamily(fixture, storyId, ['theme'])}_1`, 1],
                ['run_7', `${draftFamily(fixture, storyId, ['tone'])}_1`, 1],
                ['run_9', `${draftFamily(fixture, storyId, ['ending'])}_1`, 1],
                ['run_14', `${draftFamily(fixture, storyId, ['premise', 'ending'])}_1`, 2]
            ]);

            expect(groupsOf(fixture, storyId).map((row) => [row.key, row.revision])).toEqual([
                ['premise', 2],
                ['promise', 1],
                ['theme', 1],
                ['tone', 1],
                ['ending', 2]
            ]);

            // THE BOOK ONE SWEEP LATER: both groups carry the revision that answered the defect, and the row
            // is still `approved` — the install landed while the Author's approval was still being written,
            // so D-34's gate declined the install-time close and the sweep's `loop_reconcile_findings` step
            // closes it (the same join the batch-cap file pins). What D-66 changed is the SHAPE of the
            // moment: `resolved` names BOTH groups and `missing` is empty. There is no book state where one
            // of the two named groups is rewritten and the other is not.
            expect(fixture.store.findings.list().map((row) => [row.id, row.state, row.group_refs])).toEqual([
                ['finding_0', 'approved', [premise, ending]]
            ]);
            // The fix task is the APPROVAL's child, and the approval landed after the pass was planned — so
            // the row exists and is untouched: 0 attempts, `open`, still owed. The pass that answered the
            // defect never saw it (the same ordering the split pair of passes had).
            expect(fixture.store.tasks.list().map((row) => [row.id, row.state, row.attempts])).toEqual([['task_0', 'open', 0]]);

            // THE AUTHOR'S READ of the same moment: neither group owes the defect anything. Before D-66 this
            // same call answered premise clean and ending `owed_by_findings: ['finding_0']`.
            const mid = await fixture.api<any>('GET', `/stories/${storyId}/phrases`);

            expect((mid.body.groups as any[]).map((row) => [row.key, row.revision, row.writer_busy, row.owed_by_findings])).toEqual([
                ['premise', 2, false, []],
                ['promise', 1, false, []],
                ['theme', 1, false, []],
                ['tone', 1, false, []],
                ['ending', 2, false, []]
            ]);
            expect(mid.body.findings.map((row: any) => [row.id, row.state, row.resolved_all, row.resolved, row.missing])).toEqual([
                ['finding_0', 'approved', true, [premise, ending], []]
            ]);
            expect(mid.body.tasks.map((row: any) => [row.id, row.state])).toEqual([['task_0', 'open']]);
            expect({
                reviews_on_current_vector: mid.body.review.reviews_on_current_vector,
                deep_reviews_on_current_vector: mid.body.review.deep_reviews_on_current_vector,
                open_findings: mid.body.review.open_findings,
                blocking_findings: mid.body.review.blocking_findings,
                open_tasks: mid.body.review.open_tasks
            }).toEqual({
                reviews_on_current_vector: 0,
                deep_reviews_on_current_vector: 0,
                open_findings: 1,
                blocking_findings: 1,
                open_tasks: 1
            });

            // The Story is drainable the moment the defect closes, and the sign-off is the loop's decision
            // one sweep later — there is no second batch to wait for. `phase_signoff` is D-34's gate, not
            // work the queue still owes.
            await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 40);

            // ONE COMMIT, BOTH GROUPS. Each number-2 revision names the SAME run (`run_14`, one lower than
            // the D-65 ledger because the scoring pass opens no row on a vector nobody stamped clean), the
            // SAME whole-set claim, and the SAME refs: the batch listed the finding once however many of its groups it rewrote
            // (deduped `findingRefs` in `loop/work.ts`), and it carried the finding the planner pointed at —
            // the `confirmed` row, before the Author's approval made it work the queue could consume. So
            // `task_refs` is empty on BOTH rows, which is what "one pass, planned once" looks like: the split
            // pair used to leave one revision with the task and one without.
            expect(
                fixture.store.groupRevisions
                    .list()
                    .filter((row) => row.number === 2)
                    .map((row) => [row.id, row.group_key, row.state, row.run_ref, row.work_item_ref, row.finding_refs, row.task_refs])
            ).toEqual([
                [
                    'group_revision_5',
                    'premise',
                    'latest',
                    'run_14',
                    `${draftFamily(fixture, storyId, ['premise', 'ending'])}_1`,
                    ['finding_0'],
                    undefined
                ],
                [
                    'group_revision_6',
                    'ending',
                    'latest',
                    'run_14',
                    `${draftFamily(fixture, storyId, ['premise', 'ending'])}_1`,
                    ['finding_0'],
                    undefined
                ]
            ]);
            expect(fixture.store.findings.require('finding_0').state).toBe('fixed');
            // The row is consumed by the SWEEP that closed the finding, not by a run that finished: 0
            // attempts, because the pass that answered the defect was planned before the row existed. Under
            // the split pair this was `attempts: 1, rev: 3` — a second pass spending an attempt on a defect
            // the first one had already answered.
            expect(fixture.store.tasks.list().map((row) => [row.id, row.state, row.attempts, row.rev])).toEqual([
                ['task_0', 'done', 0, 2]
            ]);
            expect(
                groupsOf(fixture, storyId).map((row) => [row.key, row.revision, row.updated_by])
            ).toEqual([
                ['premise', 2, 'run_14'],
                ['promise', 1, 'run_3'],
                ['theme', 1, 'run_5'],
                ['tone', 1, 'run_7'],
                ['ending', 2, 'run_14']
            ]);

            // THE LEDGER: every `draft_groups` row is attempt 1 of its own family — five first drafts, one
            // pair fix, and NOT ONE `_2` anywhere. A split fix would have had to buy a second pass, so this
            // empty list is the "one defect, one pass" claim in the run table rather than in a comment.
            expect(
                fixture.store.runs
                    .list()
                    .filter((row) => (row.work_item_ref ?? '').endsWith('_2') && (row.work_item_ref ?? '').startsWith('wi_draft_groups'))
            ).toEqual([]);
            expect(
                fixture.store.runs
                    .list()
                    .filter((row) => row.work_item_ref === `${draftFamily(fixture, storyId, ['premise', 'ending'])}_1`)
                    .map((row) => [row.id, row.role, row.state, row.group_refs])
            ).toEqual([['run_14', 'writer', 'torn_down', [premise, ending]]]);
            // The text each group had is retained as history, not deleted.
            expect(fixture.store.groupRevisions.list().filter((row) => row.state === 'archived').map((row) => row.group_key)).toEqual([
                'premise',
                'ending'
            ]);

            const done = await fixture.api<any>('GET', `/stories/${storyId}/phrases`);

            expect((done.body.groups as any[]).map((row) => [row.key, row.revision, row.writer_busy, row.owed_by_findings])).toEqual([
                ['premise', 2, false, []],
                ['promise', 1, false, []],
                ['theme', 1, false, []],
                ['tone', 1, false, []],
                ['ending', 2, false, []]
            ]);
            expect(
                (done.body.findings as any[]).map((row) => [row.id, row.state, row.resolved_all, row.resolved, row.missing])
            ).toEqual([['finding_0', 'fixed', true, [premise, ending], []]]);
            expect(done.body.tasks).toEqual([]);
            expect(await storyRow(fixture, storyId)).toMatchObject({ status: 'pending', pending_kind: 'phase_signoff' });
            expect(fixture.refusals).toEqual([]);
        } finally {
            await fixture.close();
        }
    });
});
