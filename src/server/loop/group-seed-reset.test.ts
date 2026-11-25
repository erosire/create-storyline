/**
 * HARDENING (item 4, D-25a/R2/R6) — the Seed edit and the backtrack actually RESET the group book.
 *
 * Before this pass, `editSeed` cleared only the legacy mirror: on a group-managed book the CURRENT
 * text lives in the `phrase_groups` rows and the `phrases` Overview they compose, so a changed Seed
 * left the OLD Seed's prose driving every rule — `groupWorkTargets` saw five written groups and
 * offered no first draft, the review seats stayed keyed to the stale vector, and the archived
 * `group_revisions` kept their claim on the write allowance (`writeBaselineOf`) and on R3's closure
 * join. `scrapPhasesAfter` now deletes the group history with the legacy revisions (and clears any group
 * lock whose rows it deleted, D-69), and `editSeed` resets the rows it keeps. Four things are pinned here:
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
 *   5. GROUP LOCKS (R3/T6b, D-69) go with the REVISION ROWS they anchor, not with the group row. A Seed
 *      reset LIFTS every lock on the rows it takes back to `revision: 0`, because a lock at revision 0
 *      would freeze an empty section nobody ever judged — the dangling lock this rule forbids — and the
 *      cleared state is then exactly what `phrase/locks.ts` refuses to lock (`group_unwritten`), so the
 *      two modules agree about an empty group. A BACKTRACK clears them as well, for the same reason one
 *      layer down: the scrap deletes every `group_revisions` row, and `locked_revision` is a fact ABOUT
 *      one of those rows (`phrase/reviewed.ts:cleanSelectionOf` resolves a locked group's Overview entry
 *      through its `latest` row). The group's TEXT survives (L-31); only the dead flag goes. What clears
 *      NOTHING is a scrap that deletes no revision backing — a backtrack to `chapters` — pinned below.
 *      The clear has a SECOND caller, and it is the one the rail reaches without the word "backtrack":
 *      D-3c's `engine.ts:changeChapterCount` reopens phase ② by backtrack whenever the plotlines are
 *      already locked, so an Author edit to a NUMBER runs the same
 *      `scrapPhasesAfter(…, 'plotlines')` over a signed-off section. That caller is pinned below, through
 *      the verb itself.
 *      Why the stale flag is worse than an unlocked group: `phrase/revisions.ts:installGroupRevisions`
 *      turns a batch naming ANY locked group away WHOLE, before its first write (361-375), and
 *      `phrase/exclusion.ts:groupWorkTargets` never offers a locked group — so one stale flag stopped the
 *      loop re-installing all five sections and rebuilding the reviewed Overview, and nothing but an
 *      Author unlock could free it (T8's runtime probe).
 *
 * Values were read off the rig (one sweep per round trip), not guessed.
 */
import { describe, expect, it } from 'vitest';

import { generateWork, groupWriteAttempts } from './work';
import { drainPreconditions } from './status';
import { editorLockEvidenceOf } from './editor-lock';
// D-69 (T8 finding 1): the clear lives in the scrap, so the branch that deletes NO group history is
// pinned at the same layer — `scrapPhasesAfter(…, 'chapters')` is called directly, exactly as
// `engine.ts:backtrack` calls it, rather than through a phase the fixture cannot be in.
import { scrapPhasesAfter } from './invalidation';
import { createRig, seedFinding, seedTask, walkToChapters, type Rig } from './mock';
// The reviewed-rebuild half of the D-69 regression: the selection read a stale lock stranded, the live
// vector its seat keys are hashed from, and the stamp a finished deep review writes.
import {
    cleanSelectionOf,
    groupCheckSeatKey,
    groupRevisionVector,
    groupVectorHash,
    stampCleanRevisions
} from '../phrase';
import { PhraseLockRefusal, lockPhraseGroup } from '../phrase/locks';
import { ensurePhraseCatalog } from '../phrase/catalog';
import { groupPipelineOwed } from '../phrase/exclusion';
import { groupRevisionHistory, installGroupRevisions } from '../phrase/revisions';
import { AUTHOR_ATTR } from '../run/mock';
import type { PhraseGroup } from '../../shared/types';

/** The book's groups in catalog order. */
const groupsOf = (rig: Rig): PhraseGroup[] => rig.store.phraseGroups.list();

/**
 * The sentence the mock Writer installs for EVERY group, so a test that asserts a section's text names
 * the group id it was written for (the mock's own content, not a value this file invented).
 */
const writtenOf = (groupId: string): string => `The ${groupId} line this story refuses to lose.`;

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
        summaryCritics: 1,
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

/** Turns the R3 permission on through the story row (absent = OFF), so an Editor lock is legal here. */
const withLocking = (rig: Rig, enabled: boolean) => {
    const story = rig.store.stories.require(rig.storyId);

    return rig.store.stories.update(
        story.id,
        { editor_group_locking: enabled },
        { ...AUTHOR_ATTR, why: `seed: the Author ${enabled ? 'granted' : 'withdrew'} the Editor a lock seat (R3)` },
        [{ id: story.id, rev: story.rev }]
    );
};

/**
 * The lock as the ROW carries it, plus the two fields a lock is a fact ABOUT.
 *
 * The four lock fields are read with `?? null` on purpose: an UNLOCKED row leaves them OUT (absent, not
 * `false`), while a cleared row carries `false`/`null` — the difference between `unlockPhraseGroup`'s
 * write, `editSeed`'s clear, the scrap's D-69 clear of a lock whose revision rows it deleted, and a row
 * that was never locked at all. Both shapes read as unlocked to `isPhraseGroupLocked`, so a test that
 * collapsed them would not see a clear that deleted keys, or one that wrote onto rows nobody locked.
 */
const lockFieldsOf = (rig: Rig, groupId: string) => {
    const row = rig.store.phraseGroups.require(groupId);

    return {
        key: row.key,
        content: row.content,
        revision: row.revision,
        locked: row.locked ?? null,
        locked_revision: row.locked_revision ?? null,
        locked_by: row.locked_by ?? null,
        locked_at: row.locked_at ?? null
    };
};

/** The Editor's audit line for a seeded lock — `author: false`, because the crew asked for the freeze. */
const LOCK_ATTR = { run_ref: 'run_editor_judgement', author: false, why: 'seed: the Editor judged the section finished (R3)' };

/** The refusal a lock call raised, so its `code` and `details` are assertable rather than its prose alone. */
function refusalOf(call: () => unknown): PhraseLockRefusal {
    try {
        call();
    } catch (error) {
        if (error instanceof PhraseLockRefusal) return error;

        throw error;
    }

    throw new Error('expected a PhraseLockRefusal, and the call wrote instead');
}

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

    it('lifts every lock whose text it took back to revision 0, and the cleared row is what locks.ts refuses', async () => {
        const rig = await rigged();
        const groups = groupsOf(rig);
        const premise = groups.find((group) => group.key === 'premise')!;
        const tone = groups.find((group) => group.key === 'tone')!;

        withLocking(rig, true);
        // Two Editor judgements on the round-1 text (R3's seat, one per section) — the state the reset
        // has to erase. Both are legal here: the sections are written (revision 1) and unlocked.
        lockPhraseGroup(rig.store, rig.story(), premise.id, LOCK_ATTR, { actor: 'editor', at: '2026-11-24T10:00:00.000Z' });
        lockPhraseGroup(rig.store, rig.story(), tone.id, LOCK_ATTR, { actor: 'editor', at: '2026-11-24T10:00:00.000Z' });

        // The pre-state: the two rows carry the four fields, and a NEVER-locked row leaves them OUT.
        // Those are two different row shapes, and only the first one is the thing the reset must clear.
        // (The mock Writer's content is the same sentence for every section — `writtenOf` — so only the
        // number and the lock fields are asserted here; the text is this file's other test's subject.)
        const theme = groups.find((group) => group.key === 'theme')!;

        expect(lockFieldsOf(rig, premise.id)).toEqual({
            key: 'premise',
            content: writtenOf(premise.id),
            revision: 1,
            locked: true,
            locked_revision: 1,
            locked_by: 'editor',
            locked_at: '2026-11-24T10:00:00.000Z'
        });
        expect(lockFieldsOf(rig, tone.id)).toEqual({
            key: 'tone',
            content: writtenOf(tone.id),
            revision: 1,
            locked: true,
            locked_revision: 1,
            locked_by: 'editor',
            locked_at: '2026-11-24T10:00:00.000Z'
        });
        // The third section is the CONTROL row: written, judged, and left unlocked — its row never
        // carries a lock field at all, which is the shape the reset must not disturb.
        expect(lockFieldsOf(rig, theme.id)).toEqual({
            key: 'theme',
            content: writtenOf(theme.id),
            revision: 1,
            locked: null,
            locked_revision: null,
            locked_by: null,
            locked_at: null
        });

        await rig.engine.editSeed(rig.storyId, 'A lighthouse keeper trades places with the sea.', { confirm: true });

        // THE CLEAR, in the same commit that took the text away: the four fields go to `false`/`null`
        // rather than being deleted — the same shape `phrase/locks.ts:unlockPhraseGroup` writes, chosen
        // because a store `update` merges through JSON and an `undefined` value would drop the key
        // instead of clearing it. A `locked: true` row at `revision: 0` would freeze an empty section
        // nobody ever judged, and `installGroupRevisions` refuses to rewrite a locked group, so the
        // book would have had no way back.
        expect(lockFieldsOf(rig, premise.id)).toEqual({
            key: 'premise',
            content: '',
            revision: 0,
            locked: false,
            locked_revision: null,
            locked_by: null,
            locked_at: null
        });
        expect(lockFieldsOf(rig, tone.id)).toEqual({
            key: 'tone',
            content: '',
            revision: 0,
            locked: false,
            locked_revision: null,
            locked_by: null,
            locked_at: null
        });

        // Every section of the reset book reads as unlocked, whichever shape its row carries.
        expect(groupsOf(rig).every((group) => (group.locked ?? false) === false)).toBe(true);

        // THE TWO MODULES AGREE, which is the half a clear-alone test cannot show: the state the reset
        // produced is exactly the state `phrase/locks.ts` refuses to lock, with its own sentence. If the
        // reset had left the text cleared but the flag standing, this call would have written instead of
        // refusing, and a re-locked empty group would have been one Editor seat away.
        const refusal = refusalOf(() =>
            lockPhraseGroup(rig.store, rig.story(), premise.id, LOCK_ATTR, { actor: 'editor', at: '2026-11-24T11:00:00.000Z' })
        );

        expect({
            code: refusal.code,
            message: refusal.message,
            details: refusal.details
        }).toEqual({
            code: 'group_unwritten',
            message:
                'lockPhraseGroup: premise has no written text (revision 0), so there is no revision for a lock to fix — ' +
                'the loop writes it, or the Author edits it, and then the lock lands on that text',
            details: { story_id: rig.storyId, group_id: premise.id, group_key: 'premise', revision: 0, actor: 'editor' }
        });

        // …and the seat is gone with it: an unwritten group is not lockable, so the judgement generator
        // has nothing to ask about the reset book (`editorLockEvidenceOf` answers `undefined`).
        expect(editorLockEvidenceOf(rig.store, rig.story(), premise.id)).toBeUndefined();
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
            summary_critics: 1,
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
        // backtrack), the mirror still equals it (R6, in sync), and the Summary's own phase lock
        // (`summaries.locked`, L-7a) is lifted with the Story's — no group lock exists in this fixture.
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

    // D-69 (T8 finding 1). What used to be claimed here — "a backtrack keeps the lock, because a locked
    // group cannot be rolled back" — inverted the two rules: the refusal lives in
    // `phrase/revisions.ts:installGroupRevisions`, and it is precisely what a stale flag turns into a
    // deadlock. The three cases below are the corrected contract: the flag goes with the rows it names,
    // the text it hung over stays, and a scrap that deletes no rows keeps every flag.
    it('clears a lock whose revision backing the scrap just deleted, and keeps its text byte-for-byte (R2, D-69)', async () => {
        const rig = await rigged();
        const tone = groupsOf(rig).find((group) => group.key === 'tone')!;

        withLocking(rig, true);
        // A claim aimed ONLY at `tone` (R3's scope), so the lock has something to void and the backtrack
        // has a `discarded` row it must NOT resurrect.
        seedGroupFinding(rig, tone.id);
        lockPhraseGroup(rig.store, rig.story(), tone.id, LOCK_ATTR, {
            actor: 'editor',
            at: '2026-11-24T10:00:00.000Z'
        });

        // The pre-state: an Editor judgement on the current revision, and the void the lock wrote.
        expect(lockFieldsOf(rig, tone.id)).toEqual({
            key: 'tone',
            content: writtenOf(tone.id),
            revision: 1,
            locked: true,
            locked_revision: 1,
            locked_by: 'editor',
            locked_at: '2026-11-24T10:00:00.000Z'
        });
        expect(rig.store.findings.require('finding_0').state).toBe('discarded');

        await rig.engine.backtrack(rig.storyId, 'summary');

        // THE TEXT SURVIVES — `content` and `revision` are untouched, exactly as the test above pins for
        // an unlocked book — and the FOUR FIELDS go to the shape `locks.ts:unlockPhraseGroup` writes
        // (`false` + three nulls, never deleted keys). The flag named revision 1's ROW, and this commit
        // deleted that row, so there is nothing left for it to be a fact about.
        expect(lockFieldsOf(rig, tone.id)).toEqual({
            key: 'tone',
            content: writtenOf(tone.id),
            revision: 1,
            locked: false,
            locked_revision: null,
            locked_by: null,
            locked_at: null
        });

        // THE CLEAR IS EXACTLY AS BIG AS THE DELETION: five written groups, no revision rows at all (the
        // subject of every lock in the book), one row rewritten, and the four rows that were never locked
        // still leave the fields OUT rather than carrying `false`.
        expect(rig.store.groupRevisions.list().filter((row) => row.story_id === rig.storyId)).toEqual([]);
        expect(groupsOf(rig).filter((group) => group.locked === false).map((group) => group.key)).toEqual([
            'tone'
        ]);

        // The four rows that were NEVER locked keep the wire's shape: they carry none of the four keys at
        // all, which is what every projection and rail read calls "open" (`api/projections.ts`). A clear
        // that wrote `false` onto them would have moved four rows the Author never locked.
        expect(
            groupsOf(rig)
                .filter((group) => group.key !== 'tone')
                .map((group) => `${group.key}:${Object.keys(group).filter((key) => key.startsWith('locked')).join('|')}`)
        ).toEqual(['premise:', 'promise:', 'theme:', 'ending:']);

        // NOTHING ELSE MOVED: the void the lock wrote is terminal in §4.10, so the cleared flag does not
        // re-open the claim the Editor's freeze retired, and the fix task the approval created is still
        // where the Author left it.
        expect(rig.store.findings.require('finding_0').state).toBe('discarded');
        expect(rig.store.tasks.require('task_0').state).toBe('open');
    });

    it('lets the whole batch rewrite the section again, so a stale flag cannot strand the rebuild (R2, D-69)', async () => {
        const rig = await rigged();
        const tone = groupsOf(rig).find((group) => group.key === 'tone')!;

        withLocking(rig, true);
        lockPhraseGroup(rig.store, rig.story(), tone.id, LOCK_ATTR, {
            actor: 'editor',
            at: '2026-11-24T10:00:00.000Z'
        });

        await rig.engine.backtrack(rig.storyId, 'summary');

        // THE STRAND T8 PROBED, in its exact shape: five written sections with NO revision rows, so every
        // gap says `unwritten` and no Overview can compose. A stale flag would sit on top of that with no
        // way out: `installGroupRevisions` turns a batch naming a locked group away WHOLE, so the loop
        // could not re-install even the four sections that were free to move.
        const stranded = cleanSelectionOf(rig.store, rig.story());

        expect({ complete: stranded.complete, vector: stranded.vector, locked: rig.store.phraseGroups.require(tone.id).locked }).toEqual({
            complete: false,
            vector: {},
            locked: false
        });
        expect(stranded.gaps.map((gap) => `${gap.group_key}:${gap.reason}:${gap.latest}`)).toEqual([
            'premise:unwritten:0',
            'promise:unwritten:0',
            'theme:unwritten:0',
            'tone:unwritten:0',
            'ending:unwritten:0'
        ]);

        // THE BATCH INSTALLS — all five groups, the formerly-locked one included, in one commit. This is
        // the recovery the stale flag blocked; before the fix this call threw for the WHOLE batch.
        installGroupRevisions(
            rig.store,
            rig.story(),
            groupsOf(rig).map((group) => ({ group, content: `${group.key}: the round after the backtrack.` })),
            AUTHOR_ATTR,
            { runRef: 'run_writer_after_backtrack', workItemRef: 'wi_draft_groups_after_backtrack' }
        );

        // `tone` has a `latest` row again — the row `cleanSelectionOf` resolves a locked group through and
        // the row a stale flag could never point at — and its number moved, which a locked group's never
        // does (R2's install refusal).
        expect(groupRevisionHistory(rig.store, tone.id).map((row) => `${row.number}:${row.state}`)).toEqual([
            '2:latest'
        ]);
        expect(
            rig.store.groupRevisions
                .list()
                .filter((row) => row.story_id === rig.storyId && row.state === 'latest')
                .map((row) => `${row.group_key}:${row.number}`)
        ).toEqual(['premise:2', 'promise:2', 'theme:2', 'tone:2', 'ending:2']);
        expect(rig.store.phraseGroups.require(tone.id).revision).toBe(2);

        // THE BLOCKER MOVED from "no revision backing at all" to "backing that still owes its Clean
        // stamp": the first is a state only an Author could unlock, the second is work the loop runs by
        // itself.
        expect(
            cleanSelectionOf(rig.store, rig.story()).gaps.map((gap) => `${gap.group_key}:${gap.reason}:${gap.latest}`)
        ).toEqual([
            'premise:no_clean_revision:2',
            'promise:no_clean_revision:2',
            'theme:no_clean_revision:2',
            'tone:no_clean_revision:2',
            'ending:no_clean_revision:2'
        ]);

        // AND THE OVERVIEW DOES COMPOSE AGAIN: one clean-stamp pass over the live vector — the settle a
        // finished deep review performs (`reviewed.ts:stampCleanRevisions`) — closes the reviewed
        // selection, which is what the Reader's score seat, the Editor's lock seat and the Author's choose
        // are all keyed to. None of that was reachable with the dead flag standing.
        const vector = groupRevisionVector(rig.store, rig.storyId);

        expect(groupsOf(rig).map((group) => `${group.key}:${vector[group.id]}`)).toEqual([
            'premise:2',
            'promise:2',
            'theme:2',
            'tone:2',
            'ending:2'
        ]);

        const stamped = stampCleanRevisions(
            rig.store,
            rig.story(),
            { seatKey: groupCheckSeatKey(groupVectorHash(vector), 0), runRef: 'run_critic_deep_review' },
            AUTHOR_ATTR
        );

        expect(stamped.stamped.map((row) => `${row.group_key}:${row.number}`)).toEqual([
            'premise:2',
            'promise:2',
            'theme:2',
            'tone:2',
            'ending:2'
        ]);

        const rebuilt = cleanSelectionOf(rig.store, rig.story());

        expect({ complete: rebuilt.complete, gaps: rebuilt.gaps }).toEqual({ complete: true, gaps: [] });
        expect(groupsOf(rig).map((group) => `${group.key}:${rebuilt.vector[group.id]}`)).toEqual([
            'premise:2',
            'promise:2',
            'theme:2',
            'tone:2',
            'ending:2'
        ]);
    });

    it('leaves every lock standing where the scrap deletes no revision backing at all (L-31, D-69)', async () => {
        // The guard on the clear is the SAME branch as the guard on the delete, so the negative case is
        // pinned at the layer that owns it: `scrapPhasesAfter(…, 'chapters')` is the phase
        // `engine.ts:backtrack('chapters')` passes, and it deletes nothing group-shaped.
        const rig = await rigged();
        const tone = groupsOf(rig).find((group) => group.key === 'tone')!;

        withLocking(rig, true);
        lockPhraseGroup(rig.store, rig.story(), tone.id, LOCK_ATTR, {
            actor: 'editor',
            at: '2026-11-24T10:00:00.000Z'
        });

        const before = lockFieldsOf(rig, tone.id);

        expect(before).toEqual({
            key: 'tone',
            content: writtenOf(tone.id),
            revision: 1,
            locked: true,
            locked_revision: 1,
            locked_by: 'editor',
            locked_at: '2026-11-24T10:00:00.000Z'
        });

        const counts = scrapPhasesAfter(
            rig.store,
            rig.story(),
            'chapters',
            'seed: a backtrack to the phase the Story is already in (L-31)'
        );

        expect(counts.groupRevisions).toBe(0);
        // Byte-for-byte the same row: the clear is scoped to the deletion, and there was none.
        expect(lockFieldsOf(rig, tone.id)).toEqual(before);
        // The flag still anchors a live `latest` row, so it is still a judgement about real words — and
        // the selection read proves it: the round-1 vector still COMPOSES, the locked group's entry
        // resolved through the locked branch of `cleanSelectionOf` and the other four through their Clean
        // stamps. Nothing about the book's reviewed Overview changed, because nothing was deleted.
        const kept = cleanSelectionOf(rig.store, rig.story());

        expect({ complete: kept.complete, gaps: kept.gaps }).toEqual({ complete: true, gaps: [] });
        expect(kept.entries.map((entry) => `${entry.group.key}:${entry.revision.number}`)).toEqual([
            'premise:1',
            'promise:1',
            'theme:1',
            'tone:1',
            'ending:1'
        ]);
    });
});

// D-69's clear lives in the SCRAP, and `engine.ts:backtrack` is not its only caller: D-3c's
// `engine.ts:changeChapterCount` reopens phase ② by backtrack whenever the plotlines are already locked,
// so it calls `scrapPhasesAfter(…, 'plotlines')` — a rank BELOW `chapters`, so the same branch that
// deletes the `group_revisions` rows runs — from an Author verb that only mentions a NUMBER. This is the
// case a backtrack test cannot reach: the Author is in phase ③, one section is signed off, and the move
// they made was about the chapter count. Pinned through the verb, not through the helper, so a future
// change to D-3c's branch has to pass here.
describe('the D-3c chapter-count change clears a lock whose rows its backtrack deleted (D-3c, D-69)', () => {
    it('lifts the flag through the engine caller, keeps the section’s text, and leaves the void it created void', async () => {
        // Phase ③ with both sign-offs taken and the five groups written — the state an Author changes a
        // count FROM. `walkToChapters` is the loop's own walk, so the group history it leaves is the real
        // round-1 install rather than a hand-seeded stand-in.
        const rig = await walkToChapters(
            await createRig({
                summaryMode: 'groups',
                summarySampling: 5,
                summaryCritics: 1,
                // D-51 waiver, as in `rigged()` above: the walk is about the phases, not the research legs.
                crew: { researchQuestions: [] }
            }),
            2
        );
        const tone = groupsOf(rig).find((group) => group.key === 'tone')!;

        seedGroupFinding(rig, tone.id);
        // The Author's OWN lock (the actor is irrelevant to the clear, so the simplest legal actor is
        // used); the claim aimed only at `tone` is what the freeze retired.
        lockPhraseGroup(rig.store, rig.story(), tone.id, AUTHOR_ATTR, {
            actor: 'author',
            at: '2026-11-24T10:00:00.000Z'
        });

        // THE PRE-STATE IS A REAL LOCK: the flag names revision 1, revision 1's `latest` row exists, and
        // the reviewed selection COMPOSES with the locked group in it — the state the count change is
        // about to invalidate from underneath.
        const before = lockFieldsOf(rig, tone.id);

        expect(before).toEqual({
            key: 'tone',
            content: writtenOf(tone.id),
            revision: 1,
            locked: true,
            locked_revision: 1,
            locked_by: 'author',
            locked_at: '2026-11-24T10:00:00.000Z'
        });
        expect(groupRevisionHistory(rig.store, tone.id).map((row) => `${row.number}:${row.state}`)).toEqual([
            '1:latest'
        ]);
        const signedOff = cleanSelectionOf(rig.store, rig.story());

        expect({
            complete: signedOff.complete,
            gaps: signedOff.gaps,
            entries: signedOff.entries.map((entry) => `${entry.group.key}:${entry.revision.number}`)
        }).toEqual({
            complete: true,
            gaps: [],
            entries: ['premise:1', 'promise:1', 'theme:1', 'tone:1', 'ending:1']
        });
        expect(rig.store.findings.require('finding_0').state).toBe('discarded');

        // D-3c's confirm step: the plotlines are locked, so ANY count change has to say what it will
        // scrap first — and what it names is the chapter set the phase ③ walk built.
        expect(await rig.engine.changeChapterCount(rig.storyId, 2)).toEqual({
            pending_confirm: true,
            removed: ['chapter_0']
        });

        const result = await rig.engine.changeChapterCount(rig.storyId, 2, { confirm: true });

        // THE CALLER DID REOPEN PHASE ②, which is what puts the scrap in the commit at all: the phase
        // moved, `plotlines_locked` went, and the chapters were re-materialised for the new count.
        // `summary_locked` stays — D-3c reopens ②, not ①.
        expect(result).toEqual({ created: ['chapter_1', 'chapter_2'], needs_recheck: [] });
        expect({
            phase: rig.story().phase,
            plotlines_locked: rig.story().plotlines_locked,
            summary_locked: rig.story().summary_locked,
            chapters: rig.store.chapters.list().map((chapter) => `${chapter.order}:${chapter.state}`)
        }).toEqual({
            phase: 'plotlines',
            plotlines_locked: false,
            summary_locked: true,
            chapters: ['1:outlined', '2:outlined']
        });

        // THE LOCK METADATA CLEARS, in the shape `phrase/locks.ts:unlockPhraseGroup` writes: `false` plus
        // three nulls, not deleted keys. The flag named revision 1's ROW and this commit deleted every
        // `group_revisions` row of the scrapped phase, so there is nothing left for it to be a fact about.
        expect(lockFieldsOf(rig, tone.id)).toEqual({
            key: 'tone',
            content: writtenOf(tone.id),
            revision: 1,
            locked: false,
            locked_revision: null,
            locked_by: null,
            locked_at: null
        });
        expect(rig.store.groupRevisions.list().filter((row) => row.story_id === rig.storyId)).toEqual([]);

        // THE TEXT AND THE REVISION LINE ARE UNTOUCHED — the whole point of the clear being a FLAG write
        // rather than an unlock-shaped edit. Every group still carries the words round 1 installed, at the
        // number round 1 left them, and the mirror still equals them (R6).
        expect(
            groupsOf(rig).map((group) => `${group.key}:${group.revision}:${group.content === writtenOf(group.id)}`)
        ).toEqual([
            'premise:1:true',
            'promise:1:true',
            'theme:1:true',
            'tone:1:true',
            'ending:1:true'
        ]);

        const mirror = rig.store.summaries.require('summary_0');

        expect({
            premise: mirror.premise,
            promise: mirror.promise,
            theme: mirror.theme,
            tone: mirror.tone,
            ending: mirror.ending
        }).toEqual({
            premise: writtenOf(groupsOf(rig).find((group) => group.key === 'premise')!.id),
            promise: writtenOf(groupsOf(rig).find((group) => group.key === 'promise')!.id),
            theme: writtenOf(groupsOf(rig).find((group) => group.key === 'theme')!.id),
            tone: writtenOf(tone.id),
            ending: writtenOf(groupsOf(rig).find((group) => group.key === 'ending')!.id)
        });

        // THE CLEAR IS EXACTLY AS BIG AS THE DELETION: one row rewritten, and the four rows nobody locked
        // still leave the four fields OUT (their absence is the shape every projection calls "open").
        expect(groupsOf(rig).filter((group) => group.locked === false).map((group) => group.key)).toEqual(['tone']);
        expect(
            groupsOf(rig)
                .filter((group) => group.key !== 'tone')
                .map((group) => `${group.key}:${Object.keys(group).filter((key) => key.startsWith('locked')).join('|')}`)
        ).toEqual(['premise:', 'promise:', 'theme:', 'ending:']);

        // NOTHING ELSE MOVED. The claim the lock voided stays `discarded` (§4.10 makes a discard terminal,
        // and a scrap that resurrected one would invent work the Author watched close), and the fix task
        // the approval created is still open where the Author left it.
        expect(rig.store.findings.require('finding_0').state).toBe('discarded');
        expect(rig.store.tasks.require('task_0').state).toBe('open');

        // AND THE BOOK IS REBUILDABLE, which is what the stale flag used to block: with the flag gone the
        // five gaps are the honest "the history was scrapped" state — `latest: 0` for every group, the
        // formerly-locked one included, with no `locked` entry to make the gap permanent. (That a batch
        // naming all five sections then INSTALLS is pinned by the sibling test above, at the layer that
        // owns the refusal: `phrase/revisions.ts:installGroupRevisions`.)
        const stranded = cleanSelectionOf(rig.store, rig.story());

        expect({ complete: stranded.complete, gaps: stranded.gaps }).toEqual({
            complete: false,
            gaps: groupsOf(rig).map((group) => ({
                group_id: group.id,
                group_key: group.key,
                reason: 'unwritten',
                latest: 0,
                issues_open: false
            }))
        });
    });
});

describe('a legacy sampling book is untouched by the group reset rules', () => {
    it('clears its prose exactly as D-25a always did and mints no Phrase rows', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1, crew: { researchQuestions: [] } });

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

