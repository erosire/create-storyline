/**
 * HARDENING (item 4, D-25a/R2/R6) — the Seed edit and the backtrack actually RESET the group book.
 *
 * Before this pass, `editSeed` cleared only the legacy mirror: on a group-managed book the CURRENT
 * text lives in the `phrase_groups` rows and the `phrases` Overview they compose, so a changed Seed
 * left the OLD Seed's prose driving every rule — `groupWorkTargets` saw five written groups and
 * offered no first draft, the review seats stayed keyed to the stale vector, and the archived
 * `group_revisions` kept their claim on the write allowance (`writeBaselineOf`) and on R3's closure
 * join. `scrapPhasesAfter` now deletes the group history with the legacy revisions, and `editSeed`
 * resets the rows it keeps. Four things are pinned here:
 *
 *   1. SEED EDIT (rev2 + archived history in the book): every group row goes back to the fresh-
 *      catalog state `''`/`0`/null — SAME ids (R1's addresses outlive the text; the catalog is not
 *      deleted and re-minted) — the Overview row back to `''`/`0`, the mirror cleared with it, every
 *      `group_revisions` row gone (nothing `latest`, nothing archived), and the open finding NOT
 *      silently closed: a scrapped Seed's install cannot answer a defect, and a fresh defect against
 *      the new Seed must not be pre-answered either (R3 closure stays a JOIN on claims).
 *   2. The NEXT Writer starts at revision 1 on an empty canvas: the planner's batch is the five
 *      unwritten groups again (a legacy book's cleared prose, phrased in group terms).
 *   3. `ensurePhraseCatalog` re-pressed after the reset is a NO-OP — the ids it returns are the ids
 *      that existed before, no rows are created, and the reset state survives it (R1 stability).
 *   4. BACKTRACK to `summary` keeps the L-31 convention: the reopened phase's OWN artifact survives
 *      (group text and mirror stay in sync as the base for another round), while the phase's
 *      REVISION HISTORY goes with the scrapped work — exactly what the legacy flow does to
 *      `revisions` rows. And a sibling Story's catalog is untouched by either operation.
 *
 * Values were read off the rig (one sweep per round trip), not guessed.
 */
import { describe, expect, it } from 'vitest';

import { generateWork, groupWriteAttempts } from './work';
import { drainPreconditions } from './status';
import { createRig, seedFinding, seedTask, type Rig } from './mock';
import { ensurePhraseCatalog } from '../phrase/catalog';
import { groupPipelineOwed } from '../phrase/exclusion';
import { groupRevisionHistory, installGroupRevisions } from '../phrase/revisions';
import { AUTHOR_ATTR } from '../run/mock';
import type { PhraseGroup } from '../../shared/types';

/** The book's groups in catalog order. */
const groupsOf = (rig: Rig): PhraseGroup[] => rig.store.phraseGroups.list();

/** Every job kind the planner would offer right now, in priority order. */
const jobKinds = (rig: Rig) =>
    generateWork(rig.store, rig.story(), { at: '2026-11-24T10:00:00.000Z', phase: 'summary' }).map(
        (job) => job.item.kind
    );

/** The batch the planner would offer — the same call `engine.sweep()` makes. */
const draftBatches = (rig: Rig) =>
    generateWork(rig.store, rig.story(), { at: '2026-11-24T10:00:00.000Z', phase: 'summary' })
        .filter((job) => job.item.kind === 'draft_groups')
        .map((job) => (job.item.groupRefs ?? []).map((ref) => rig.store.phraseGroups.require(ref).key));

/** A group-managed book with the full first round already installed, then one group re-written. */
async function rigged(): Promise<Rig> {
    const rig = await createRig({
        summaryMode: 'groups',
        summarySampling: 5,
        summaryReaders: 1,
        // D-51 waiver: the phase opens straight at the Writer batch, so the sweeps below are about
        // the reset, not about the research stages.
        crew: { researchQuestions: [] }
    });

    // Round 1: one pass writes all five groups (five `latest` revisions at number 1, mirror synced).
    await rig.run();

    return rig;
}

/** Write an approved defect against one group (the deep review's output, seeded — cf. phase1-groups). */
const seedGroupFinding = (rig: Rig, groupId: string) => {
    const seeded = seedFinding(rig.store, rig.storyId, {
        target_ref: 'summary_0',
        criterion_ref: 'C-14',
        cost: 'critical',
        state: 'approved',
        title: 'the premise contradicts the Seed',
        detail: 'the Overview promises a cartographer; the Seed says the map was destroyed',
        fingerprint: 'C-14|summary_0'
    });
    const finding = rig.store.findings.update(
        seeded.id,
        { group_refs: [groupId] },
        { run_ref: null, author: true, why: 'seed: the defect is scoped to one group (R3)' },
        [{ id: seeded.id, rev: seeded.rev }]
    );

    seedTask(rig.store, rig.storyId, {
        kind: 'fix',
        title: 'fix finding_0: pay the premise the Seed states',
        detail: `C-14 on summary_0 · ${finding.id}`,
        owner_role: 'writer',
        finding_ref: finding.id
    });

    return finding;
};

/** Bring one group to revision 2 with its revision 1 archived — the state the reset must clear. */
const installSecondPass = (rig: Rig, group: PhraseGroup) => {
    installGroupRevisions(
        rig.store,
        rig.story(),
        [{ group, content: 'premise: the SECOND pass text, answering the defect.' }],
        AUTHOR_ATTR,
        { runRef: 'run_writer_fix', workItemRef: 'wi_draft_groups_fix_1' }
    );
};

describe('the Seed edit resets the group book to re-grow from the new Seed (D-25a)', () => {
    it('clears text, numbers, Overview and mirror in place, drops every group revision, and keeps the ids', async () => {
        const rig = await rigged();
        const premise = groupsOf(rig).find((group) => group.key === 'premise')!;

        seedGroupFinding(rig, premise.id);
        installSecondPass(rig, premise);
        // `phraseGroups` rows are immutable values — re-read the row the install just updated.
        const premiseNow = rig.store.phraseGroups.require(premise.id);

        // The pre-state this test is about: one group at revision 2 with revision 1 archived, the
        // Overview composed at revision 2, and the mirror carrying the SECOND pass's text.
        const idsBefore = groupsOf(rig).map((group) => group.id);
        const phraseBefore = rig.store.phrases.require(rig.store.phrases.list()[0]!.id);
        const summaryBefore = rig.store.summaries.require('summary_0');

        expect(groupRevisionHistory(rig.store, premise.id).map((row) => `${row.number}:${row.state}`)).toEqual([
            '2:latest',
            '1:archived'
        ]);
        expect(premiseNow.revision).toBe(2);
        expect(premiseNow.content).toBe('premise: the SECOND pass text, answering the defect.');
        expect(summaryBefore.premise).toBe('premise: the SECOND pass text, answering the defect.');
        expect(phraseBefore.revision).toBe(2);

        await rig.engine.editSeed(rig.storyId, 'A lighthouse keeper trades places with the sea.', {
            confirm: true
        });

        const story = rig.story();

        // The Story reset itself still happens exactly as D-25a describes it.
        expect({
            phase: story.phase,
            idea: story.idea,
            summary_locked: story.summary_locked,
            sampling_round: story.sampling_round,
            sampling_wave: story.sampling_wave
        }).toEqual({
            phase: 'summary',
            idea: 'A lighthouse keeper trades places with the sea.',
            summary_locked: false,
            sampling_round: 0,
            sampling_wave: 0
        });

        // The five group rows survive AS THE SAME ADDRESSES and hold the fresh-catalog state —
        // `''` + `0` + null authorship, which is what `groupWorkTargets` reads as first-draft work.
        expect(groupsOf(rig).map((group) => group.id)).toEqual(idsBefore);
        expect(
            groupsOf(rig).map(
                (group) => `${group.key}:${JSON.stringify(group.content)}:${group.revision}:${String(group.updated_by)}`
            )
        ).toEqual([
            'premise:"":0:null',
            'promise:"":0:null',
            'theme:"":0:null',
            'tone:"":0:null',
            'ending:"":0:null'
        ]);

        // No `latest`, no archived: the scrapped Seed's installs are gone with the legacy revisions.
        expect(rig.store.groupRevisions.list().filter((row) => row.story_id === rig.storyId)).toEqual([]);

        // The Overview row: same id, nothing composed, revision 0 — the state `catalog.ts` mints.
        const phrase = rig.store.phrases.require(phraseBefore.id);

        expect({ id: phrase.id, content: phrase.content, revision: phrase.revision }).toEqual({
            id: phraseBefore.id,
            content: '',
            revision: 0
        });

        // The mirror was cleared with it (and is NOT rewritten back by the reset): empty prose,
        // unlocked, `chapter_count` untouched (D-3b: Author truth).
        const summary = rig.store.summaries.require(summaryBefore.id);

        expect({
            premise: summary.premise,
            promise: summary.promise,
            theme: summary.theme,
            tone: summary.tone,
            ending: summary.ending,
            locked: summary.locked,
            chapter_count: summary.chapter_count
        }).toEqual({
            premise: '',
            promise: '',
            theme: '',
            tone: '',
            ending: '',
            locked: false,
            chapter_count: summaryBefore.chapter_count
        });

        // Nothing closed a defect on a scrapped Seed (R3): the approved row and its fix task are
        // exactly where the Author left them, now pointing at a book with five unwritten groups.
        const finding = rig.store.findings.require('finding_0');

        expect({ state: finding.state, group_refs: finding.group_refs }).toEqual({
            state: 'approved',
            group_refs: [premise.id]
        });
        expect(rig.store.tasks.require('task_0').state).toBe('open');
    });

    it('re-arms phase ① from the new Seed and leaves nothing parked (R1, R2)', async () => {
        const rig = await rigged();
        const idsBefore = groupsOf(rig).map((group) => group.id);

        await rig.engine.editSeed(rig.storyId, 'A signalman answers a letter written after his death.', {
            confirm: true
        });

        // Re-pressing the importer/creator must not mint a second catalog: the ids are stable and the
        // reset state survives it (idempotent by skipping, `phrase/catalog.ts`).
        const again = ensurePhraseCatalog(rig.store, rig.story(), AUTHOR_ATTR)!;

        expect(again.groups.map((group) => group.id)).toEqual(idsBefore);
        expect(groupsOf(rig).map((group) => group.id)).toEqual(idsBefore);
        expect(groupsOf(rig).filter((group) => group.revision !== 0 || group.content !== '')).toEqual([]);
        expect(rig.store.phrases.list()).toHaveLength(1);

        // A changed Seed re-arms phase ① from the TOP: the new hash has no accepted Seed Brief, so the
        // queue's only candidate is the Editor's structure pass and every phase-① job below it — the
        // grouped Writer batch included — is withheld (§6.4 step 1).
        expect(jobKinds(rig)).toEqual(['structure_seed']);
        expect(draftBatches(rig)).toEqual([]);

        // The write allowance restarted WITH the text, so nothing is parked on the old Seed's attempts
        // and an Overview of five EMPTY groups reads as OWED rather than drained. This is the hazard the
        // reset would create if the attempt baseline kept pointing at the pre-reset rows: the loop would
        // refuse to write a group it had already passed twice under the previous Seed, and the rail would
        // call an empty Summary finished (`phrase/exclusion.ts:writeBaselineOf`).
        expect(groupsOf(rig).map((group) => groupWriteAttempts(rig.store, rig.story(), group))).toEqual([
            0, 0, 0, 0, 0
        ]);
        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({
            drafts: 5,
            structuredReviews: 0,
            deepReviews: 0
        });

        // …and the drain probe tells the SAME story in the Author's words (§6.7): the phase waits on the
        // structure pass, not on a Summary it no longer holds.
        expect(drainPreconditions(rig.store, rig.story()).unmet).toEqual([
            'no accepted Seed Brief describes the current Seed — the Editor has not structured it yet (§6.4 step 1)'
        ]);

        // NOTE for the next reader: this fixture cannot show the batch re-writing the book end to end —
        // the mock Goal passes on the cleared prose, so L-29's sign-off stops the crew on the very next
        // sweep and `structure_seed` is never dispatched. The pins above are the reset's contract; the
        // sweep assertion here just records why no Writer run appears in the ledger.
        await rig.step();

        expect({ status: rig.story().status, pending_kind: rig.story().pending_kind }).toEqual({
            status: 'pending',
            pending_kind: 'phase_signoff'
        });
    });

    it('leaves a sibling Story\u2019s catalog and history completely untouched', async () => {
        const rig = await rigged();

        // Story B: its own group-managed book, one install deep, created through the same engine.
        const created = await rig.engine.createStory({
            title: 'The Signalman',
            idea: 'A signalman answers a letter written after his death.',
            chapter_count: 1,
            summary_sampling: 5,
            summary_readers: 1,
            summary_mode: 'groups'
        });
        const storyB = rig.store.stories.require(created.story_id);
        const groupsB = rig.store.phraseGroups.list().filter((group) => group.story_id === storyB.id);

        expect(groupsB.map((group) => group.key)).toEqual(['premise', 'promise', 'theme', 'tone', 'ending']);

        installGroupRevisions(
            rig.store,
            storyB,
            groupsB.map((group) => ({ group, content: `${group.key}: B keeps this text.` })),
            AUTHOR_ATTR,
            { runRef: 'run_b', workItemRef: 'wi_draft_groups_b_1' }
        );

        const beforeB = rig.store
            .phraseGroups.list()
            .filter((group) => group.story_id === storyB.id)
            .map((group) => ({ id: group.id, content: group.content, revision: group.revision }));
        const revisionsB = rig.store.groupRevisions.list().filter((row) => row.story_id === storyB.id).length;

        await rig.engine.editSeed(rig.storyId, 'A cartographer is erased from every chart she drew.', {
            confirm: true
        });

        expect(
            rig.store.phraseGroups.list().filter((group) => group.story_id === storyB.id).map((group) => ({
                id: group.id,
                content: group.content,
                revision: group.revision
            }))
        ).toEqual(beforeB);
        expect(rig.store.groupRevisions.list().filter((row) => row.story_id === storyB.id)).toHaveLength(revisionsB);
    });
});

describe('backtrack to summary keeps the L-31 convention on a grouped book (D-25)', () => {
    it('drops the group revision history but keeps the current text and the in-sync mirror as the base', async () => {
        const rig = await rigged();
        const before = groupsOf(rig).map((group) => `${group.key}:${group.revision}`);
        const mirrorBefore = rig.store.summaries.require('summary_0');
        const proseBefore = {
            premise: mirrorBefore.premise,
            promise: mirrorBefore.promise,
            theme: mirrorBefore.theme,
            tone: mirrorBefore.tone,
            ending: mirrorBefore.ending
        };

        expect(rig.store.groupRevisions.list().filter((row) => row.story_id === rig.storyId)).toHaveLength(5);

        await rig.engine.backtrack(rig.storyId, 'summary');

        // The scrapped pass's HISTORY goes, exactly like the legacy `revisions` rows and for the same
        // §6.6 reason — the round restarts with no memory of it.
        expect(rig.store.groupRevisions.list().filter((row) => row.story_id === rig.storyId)).toEqual([]);

        // The reopened phase's OWN artifact survives: the group text and its numbers stay (the base
        // for another round, the same reason the `summaries` row keeps its prose on a legacy
        // backtrack), the mirror still equals it (R6, in sync), and the lock is lifted (L-31).
        expect(groupsOf(rig).map((group) => `${group.key}:${group.revision}`)).toEqual(before);

        const summary = rig.store.summaries.require('summary_0');

        expect({
            premise: summary.premise,
            promise: summary.promise,
            theme: summary.theme,
            tone: summary.tone,
            ending: summary.ending,
            locked: summary.locked
        }).toEqual({ ...proseBefore, locked: false });
        expect(rig.story().summary_locked).toBe(false);

        // Nothing is owed a first draft: five written groups, no open finding, no target — the
        // honest parked state, not a phantom reset.
        expect(draftBatches(rig)).toEqual([]);
    });
});

describe('a legacy sampling book is untouched by the group reset rules', () => {
    it('clears its prose exactly as D-25a always did and mints no Phrase rows', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1, crew: { researchQuestions: [] } });

        await rig.run();

        const filled = rig.store.summaries.require('summary_0');

        expect(filled.premise).not.toBe('');

        await rig.engine.editSeed(rig.storyId, 'A dog walks home through a changed valley.', { confirm: true });

        const cleared = rig.store.summaries.require('summary_0');

        expect({
            premise: cleared.premise,
            promise: cleared.promise,
            theme: cleared.theme,
            tone: cleared.tone,
            ending: cleared.ending,
            locked: cleared.locked
        }).toEqual({ premise: '', promise: '', theme: '', tone: '', ending: '', locked: false });

        // The group machinery never touches this book: no Phrase row, no catalog, no revisions.
        expect(rig.store.phrases.list()).toEqual([]);
        expect(rig.store.phraseGroups.list()).toEqual([]);
        expect(rig.store.groupRevisions.list()).toEqual([]);
    });
});

