/**
 * PHRASE GROUP LOCK (R3/T6b) — the seat module's OWN reads, with no crew and no sweep.
 *
 * `loop/phase1-editor-lock.test.ts` proves the seat through the live loop: a run happens, a flag lands,
 * a drain stays green. This file proves the four definitions that loop test only exercises, sentence by
 * sentence, because every one of them is shared by three call sites (`work.ts`'s candidate,
 * `run/phase1-prompt.ts:compileGroupLockPrompt`, and `engine.ts:settleJob`) and a drift between them is a
 * judgement made about a section the pass was never shown:
 *
 *   1. THE KEY IS THE SEAT'S ADDRESS — `wi_group_lock_<cleanVectorHash>_<groupId>`, split on the FIRST
 *      underscore after the family prefix (a vector hash has no underscore, so that separator is unique,
 *      and a group id may contain one). A FOREIGN key answers two empty strings, which every caller reads
 *      as "this run decided no lock"; the whole safety of the settle rests on that, because the run whose
 *      answer is being applied is identified by its key alone.
 *   2. THE ELIGIBILITY READ (`editorLockEvidenceOf`) — the five conditions of the file header, one test
 *      each: the Setting, a complete reviewed Summary whose entry for this group IS its current text, a
 *      Reader row for this group at exactly that vector with a non-blank rationale, the group written and
 *      unlocked, and no live Writer over it. Each exclusion is per GROUP: the sibling sections keep their
 *      seats, which is what makes one lock unable to spend another section's turn.
 *   3. THE SPENT SEAT (`groupLockSeatSpent`) — one decision per section per clean vector, read across the
 *      run rows so a restart reproduces it, and SCOPED TO THE BOOK because the key carries no story id.
 *   4. THE REFUSAL SENTENCES — every branch of `parseGroupLockAnswer` (the contract, at settle time) and
 *      of `editorLockGuardReason` (the state, re-read inside the commit). These strings are the product's
 *      copy: they are what an Author or a future rail line reads when a freeze did not happen, so a
 *      rewording that loses the reason is a test failure here, on purpose.
 *
 * Every expectation is an exact value: full objects with `toEqual`, never a range or a "contains". The
 * sentences are written out in the assertions rather than matched loosely, so this file doubles as the
 * transcription of the refusals for anyone reading the feature from the outside.
 */
import { describe, expect, it } from 'vitest';
import {
    GROUP_LOCK_CLAIM_RENDER_CAP,
    GROUP_LOCK_ITEM_PREFIX,
    editorLockEvidenceOf,
    editorLockGuardReason,
    editorLockMayLock,
    editorLockSeatTargets,
    groupLockSeatKey,
    groupLockSeatOf,
    groupLockSeatSpent,
    isGroupLockRunKey,
    lockedPeerLines,
    parseGroupLockAnswer
} from './editor-lock';
// The seat families this key has to stay distinguishable from, and the owed-work list it must NOT be in.
import {
    GROUP_DRAFT_ITEM_PREFIX,
    GROUP_PIPELINE_RUN_PREFIXES,
    groupCheckSeatKey,
    groupReviewSeatKey,
    sectionScoreClaimKey
} from '../phrase/exclusion';
import { createRig, type CrewBehaviour, type Rig } from './mock';
import { storyPhrase } from '../phrase/catalog';
import { lockPhraseGroup } from '../phrase/locks';
import { cleanSelectionOf, stampCleanRevisions } from '../phrase/reviewed';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { AUTHOR_ATTR } from '../run/mock';
import type { Store } from '../store';
import type { PhraseGroup, Run, Story, SummaryScore } from '../../shared/types';

/** A vector hash of the shape the real ones have: 16 hex characters, no underscores. */
const VECTOR = '0123456789abcdef';

// ---------------------------------------------------------------------------
// The fixture — the same shape `loop/phase1-editor-lock.test.ts` arms the live loop with
// ---------------------------------------------------------------------------

const groupsOf = (store: Store, storyId: string): PhraseGroup[] =>
    store.phraseGroups.list().filter((group) => group.story_id === storyId);

const idOf = (store: Store, storyId: string, key: string): string =>
    groupsOf(store, storyId).find((group) => group.key === key)!.id;

const vectorOf = (store: Store, storyId: string): string => groupVectorHash(groupRevisionVector(store, storyId));

/** The Author's permission, switched through the story row. Absent is OFF, so this line IS the gate. */
function withLocking(store: Store, storyId: string, enabled: boolean): Story {
    const story = store.stories.require(storyId);

    return store.stories.update(
        story.id,
        { editor_group_locking: enabled },
        { ...AUTHOR_ATTR, why: `seed: the Author ${enabled ? 'granted' : 'withdrew'} the Editor a lock seat (R3)` },
        [{ id: story.id, rev: story.rev }]
    );
}

/** Text for all five sections, through the production install path (R2's numbering). */
function installAll(rig: Rig, content: string, workItemRef = `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_1`) {
    return installGroupRevisions(
        rig.store,
        rig.story(),
        // FRESH rows: an install CASes each group row, so a row captured before an earlier write trips the
        // store's guard instead of testing the rule.
        groupsOf(rig.store, rig.storyId).map((group) => ({
            group: rig.store.phraseGroups.require(group.id),
            content: `${group.key}: ${content}`
        })),
        AUTHOR_ATTR,
        { runRef: 'run_writer', workItemRef }
    );
}

/** Installs ONE section's new text — the state that puts a section ahead of the reviewed Overview. */
function installOne(rig: Rig, groupId: string, content: string) {
    return installGroupRevisions(rig.store, rig.story(), [{ group: rig.store.phraseGroups.require(groupId), content }], AUTHOR_ATTR, {
        runRef: 'run_writer_one',
        workItemRef: `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_one`
    });
}

/** Closes the cross-group pass over the current vector: the write that makes a revision CLEAN (D-67). */
function stampClean(rig: Rig, runRef = 'run_check_1') {
    return stampCleanRevisions(
        rig.store,
        rig.story(),
        { seatKey: groupCheckSeatKey(vectorOf(rig.store, rig.storyId), 1), runRef },
        AUTHOR_ATTR
    );
}

/**
 * The Reader's row for ONE section at ONE vector (D-65). Written by hand rather than by running the
 * scoring seat, so the fixture states its own precondition. The rationale is the field this module reads
 * as EVIDENCE (the D-65 exception), so its exact words are asserted, and the score is a number nobody
 * here compares against a threshold.
 */
function scoreRowFor(rig: Rig, group: PhraseGroup, vectorHash: string): SummaryScore {
    return rig.store.summaryScores.create(
        {
            story_id: rig.storyId,
            phrase_id: storyPhrase(rig.store, rig.storyId)!.id,
            vector_hash: vectorHash,
            group_id: group.id,
            group_key: group.key,
            score: 76,
            rationale: `${group.key} holds as written and nothing in the Overview contradicts it`,
            evidence: `${group.key}: the installed text.`,
            run_ref: 'run_score_1',
            work_item_ref: sectionScoreClaimKey(vectorHash)
        },
        { ...AUTHOR_ATTR, why: `seed: the Reader scored ${group.key} at ${vectorHash} (D-65)` }
    );
}

/**
 * The state a lock seat is legitimately offered from: five sections at revision 1, all five stamped CLEAN,
 * a Reader row for each at that vector, and the permission set. The vector comes back so each test states
 * the keys and sentences it expects instead of re-deriving them inline.
 */
async function armed(crew: CrewBehaviour = {}, enabled = true) {
    const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 1, crew: { researchQuestions: [], ...crew } });

    installAll(rig, 'the installed text.');
    stampClean(rig);

    const vector = vectorOf(rig.store, rig.storyId);

    for (const group of groupsOf(rig.store, rig.storyId)) scoreRowFor(rig, group, vector);

    withLocking(rig.store, rig.storyId, enabled);

    return { rig, vector, groups: groupsOf(rig.store, rig.storyId) };
}

/** The eligible sections, in the order the generator walks them (catalog order). */
const targetKeys = (store: Store, story: Story): string[] => editorLockSeatTargets(store, story).map((evidence) => evidence.group.key);

/** A live Writer run over the given sections — the only kind of run that can move a group's text. */
function liveWriterRun(rig: Rig, groupRefs: string[], state: Run['state'] = 'working') {
    return rig.store.runs.create(
        {
            story_id: rig.storyId,
            // A DRAFT claim key: `phrase/exclusion.ts:GROUP_HOLDING_KINDS` says only `draft_groups` holds.
            work_item_ref: `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_${VECTOR}_1`,
            role: 'writer',
            state,
            started_at: '2026-11-25T10:00:01.000Z',
            ended_at: state === 'working' ? null : '2026-11-25T10:00:02.000Z',
            tokens: 3,
            kind: 'work',
            no_op: false,
            delegated: [],
            group_refs: groupRefs
        },
        { run_ref: null, author: false, why: 'seed: a Writer pass over these sections' }
    );
}

/** A run row on a SEAT key — the write that spends it, whatever the answer said. */
function seatRun(rig: Rig, key: string, storyId: string, state: Run['state']) {
    return rig.store.runs.create(
        {
            story_id: storyId,
            work_item_ref: key,
            role: 'editor',
            state,
            started_at: '2026-11-25T10:00:01.000Z',
            ended_at: state === 'torn_down' ? '2026-11-25T10:00:02.000Z' : null,
            tokens: 2,
            kind: 'work',
            no_op: false,
            delegated: [],
            group_refs: [groupLockSeatOf(key).group_id]
        },
        { run_ref: null, author: false, why: `seed: an Editor judgement pass on ${key}` }
    );
}

// ---------------------------------------------------------------------------
// 1. The key
// ---------------------------------------------------------------------------

describe('the seat key is the seat\u2019s address (R3)', () => {
    it('builds and reads back the pair the seat is identified by', () => {
        const key = groupLockSeatKey(VECTOR, 'group_9');

        expect(key).toBe('wi_group_lock_0123456789abcdef_group_9');
        expect(GROUP_LOCK_ITEM_PREFIX).toBe('wi_group_lock');
        expect(groupLockSeatOf(key)).toEqual({ vector_hash: VECTOR, group_id: 'group_9' });
        expect(isGroupLockRunKey(key)).toBe(true);
    });

    it('splits on the FIRST underscore after the prefix, so an id that contains one survives', () => {
        // The rule, not just the common case: a vector hash never contains an underscore, so the first one
        // after the prefix IS the separator — and an id like `cron_job_7` must come back WHOLE rather than
        // truncated at its own underscore (a truncated id would silently name another section).
        expect(groupLockSeatOf(`${GROUP_LOCK_ITEM_PREFIX}_${VECTOR}_cron_job_7`)).toEqual({
            vector_hash: VECTOR,
            group_id: 'cron_job_7'
        });
        expect(groupLockSeatKey(VECTOR, 'cron_job_7')).toBe(`${GROUP_LOCK_ITEM_PREFIX}_${VECTOR}_cron_job_7`);
    });

    it('answers nothing for every foreign claim key, so a wrong run can never be read as a judgement', () => {
        const foreign = [
            // The three seats this family lives beside, plus the legacy families' shapes.
            groupReviewSeatKey(VECTOR, 1),
            groupCheckSeatKey(VECTOR, 1),
            sectionScoreClaimKey(VECTOR),
            `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_${VECTOR}_1`,
            'wi_review_summary_1_a1',
            'wi_whole_check',
            'wi_deep_summary_1_a1',
            // And the malformed neighbours of the lock family itself: a half-filled key is NOT a seat.
            GROUP_LOCK_ITEM_PREFIX,
            `${GROUP_LOCK_ITEM_PREFIX}_${VECTOR}`,
            `${GROUP_LOCK_ITEM_PREFIX}__group_9`,
            `${GROUP_LOCK_ITEM_PREFIX}_${VECTOR}_`,
            ''
        ];

        expect(foreign.map(groupLockSeatOf)).toEqual(foreign.map(() => ({ vector_hash: '', group_id: '' })));
        expect(foreign.map(isGroupLockRunKey)).toEqual(foreign.map(() => false));
    });

    it('is in no owed-work family, which is what makes the seat optional work (R3)', () => {
        // The data behind the claim in `phase1-editor-lock.test.ts`: neither `groupPipelineOwed` nor the
        // drain probe can count this family, because the prefix list that defines the group pipeline does
        // not contain it. Sign-off, the drain and the write allowance therefore stay as they were.
        expect(GROUP_PIPELINE_RUN_PREFIXES.filter((prefix) => prefix.startsWith(GROUP_LOCK_ITEM_PREFIX))).toEqual([]);
        expect([...GROUP_PIPELINE_RUN_PREFIXES]).toEqual([
            'wi_draft_groups_',
            'wi_review_groups_',
            'wi_group_check_',
            'wi_summary_score_'
        ]);
        // The render cap is the prompt's bound, asserted here so a raised cap is a deliberate change.
        expect(GROUP_LOCK_CLAIM_RENDER_CAP).toBe(12);
    });
});

// ---------------------------------------------------------------------------
// 2. The eligibility read
// ---------------------------------------------------------------------------

describe('the evidence read: five conditions, each excluding ONE section (R3)', () => {
    it('arms one seat per section at an armed vector, with exactly the evidence the prompt renders', async () => {
        const { rig, vector, groups } = await armed();
        const story = rig.story();
        const targets = editorLockSeatTargets(rig.store, story);

        // Catalog order, one entry per section, all keyed by the SAME clean vector.
        expect(targets.map((evidence) => `${evidence.group.key}:${evidence.revision.number}:${evidence.vector_hash === vector}`)).toEqual([
            'premise:1:true',
            'promise:1:true',
            'theme:1:true',
            'tone:1:true',
            'ending:1:true'
        ]);

        const premise = targets.find((evidence) => evidence.group.key === 'premise')!;

        // The Reader row, in the shape the seat weighs it: the rationale verbatim, the number beside it,
        // and no comparison — this module never reads a score against a threshold.
        expect({
            score: premise.score.score,
            rationale: premise.score.rationale,
            group_key: premise.score.group_key,
            vector_hash: premise.score.vector_hash,
            same_vector_as_seat: premise.score.vector_hash === premise.vector_hash
        }).toEqual({
            score: 76,
            rationale: 'premise holds as written and nothing in the Overview contradicts it',
            group_key: 'premise',
            vector_hash: vector,
            same_vector_as_seat: true
        });
        // The clean revision is the CURRENT text — the revision a lock would fix.
        expect({ clean: premise.revision.number, current: premise.group.revision }).toEqual({ clean: 1, current: 1 });
        // Nothing locked, nothing open: the peer fields state that explicitly rather than leaving it implied.
        expect(premise.locked_peers).toEqual([]);
        expect(premise.open_claims).toEqual([]);
        expect(premise.closed_claims).toEqual([]);
        // The peers are the OTHER four — the section itself is never its own peer.
        expect(premise.unlocked_peers.map((group) => group.key)).toEqual(['promise', 'theme', 'tone', 'ending']);
        expect(targetKeys(rig.store, story)).toEqual(groups.map((group) => group.key));
    });

    it('answers nothing at all while the Setting is absent, and the identical book answers five seats once it is on', async () => {
        const { rig, groups } = await armed({}, false);

        expect(cleanSelectionOf(rig.store, rig.story()).complete).toBe(true);
        expect(editorLockSeatTargets(rig.store, rig.story())).toEqual([]);
        // The per-group read agrees with the sweep read — one definition, two entry points.
        expect(groups.map((group) => editorLockEvidenceOf(rig.store, rig.story(), group.id))).toEqual(
            groups.map(() => undefined)
        );

        withLocking(rig.store, rig.storyId, true);

        expect(targetKeys(rig.store, rig.story())).toEqual(['premise', 'promise', 'theme', 'tone', 'ending']);
    });

    it('needs the clean stamp: text that never survived a cross-group pass is not lockable (D-67)', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 1, crew: { researchQuestions: [] } });

        installAll(rig, 'the installed text.');

        const vector = vectorOf(rig.store, rig.storyId);

        for (const group of groupsOf(rig.store, rig.storyId)) scoreRowFor(rig, group, vector);

        withLocking(rig.store, rig.storyId, true);

        // Written, scored, permitted — and still nothing, because no cross-group pass has passed this
        // Overview. A lock here would freeze text nobody tried to break.
        expect(cleanSelectionOf(rig.store, rig.story()).complete).toBe(false);
        expect(editorLockSeatTargets(rig.store, rig.story())).toEqual([]);

        stampClean(rig);

        expect(cleanSelectionOf(rig.store, rig.story()).complete).toBe(true);
        expect(targetKeys(rig.store, rig.story())).toEqual(['premise', 'promise', 'theme', 'tone', 'ending']);
    });

    it('drops only the section whose newest text post-dates the reviewed Overview, and keeps its four neighbours', async () => {
        const { rig, vector, groups } = await armed();
        const theme = groups.find((group) => group.key === 'theme')!;

        installOne(rig, theme.id, 'a rewritten theme.');

        // The selection itself is still COMPLETE (it stands behind each group's newest CLEAN row), so this
        // is the per-group clause doing the work, not the whole-vector one.
        expect(cleanSelectionOf(rig.store, rig.story()).complete).toBe(true);
        expect(cleanSelectionOf(rig.store, rig.story()).vector_hash).toBe(vector);
        expect(editorLockEvidenceOf(rig.store, rig.story(), theme.id)).toBeUndefined();
        expect(targetKeys(rig.store, rig.story())).toEqual(['premise', 'promise', 'tone', 'ending']);

        // The seat re-arms by itself when a deep pass clears the new text AND the Reader has read it: the
        // key is that selection's hash, so there is no counter to reset — but a seat is an adjudication
        // OVER the Reader's reading of THIS Overview, so until a new vector has score rows of its own, an
        // answer would weigh a number describing the old one.
        stampClean(rig, 'run_check_2');

        const next = cleanSelectionOf(rig.store, rig.story()).vector_hash;

        expect(next).not.toBe(vector);
        expect(editorLockSeatTargets(rig.store, rig.story())).toEqual([]);

        for (const group of groupsOf(rig.store, rig.storyId)) scoreRowFor(rig, group, next);

        expect(targetKeys(rig.store, rig.story())).toEqual(['premise', 'promise', 'theme', 'tone', 'ending']);
        expect(editorLockEvidenceOf(rig.store, rig.story(), theme.id)!.vector_hash).toBe(next);
        expect(editorLockEvidenceOf(rig.store, rig.story(), theme.id)!.revision.number).toBe(2);
    });

    it('requires the Reader row at that exact vector, and refuses one whose rationale is blank (D-65)', async () => {
        const { rig, vector, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;
        const row = rig.store.summaryScores.list().find((score) => score.group_id === premise.id)!;

        // The number exists, but it describes the PREVIOUS Overview. An answer here would weigh a reading
        // of words the seat is not being shown.
        const moved = rig.store.summaryScores.update(
            row.id,
            { vector_hash: 'ffffffffffffffff' },
            { ...AUTHOR_ATTR, why: 'seed: the score row describes another vector' },
            [{ id: row.id, rev: row.rev }]
        );

        expect(moved.vector_hash).toBe('ffffffffffffffff');
        expect(editorLockEvidenceOf(rig.store, rig.story(), premise.id)).toBeUndefined();
        expect(targetKeys(rig.store, rig.story())).toEqual(['promise', 'theme', 'tone', 'ending']);

        // Back at the right vector, but with no REASON: a bare number is exactly the input the Author
        // refused to make a rule out of, so it is not evidence and there is no seat.
        rig.store.summaryScores.update(
            row.id,
            { vector_hash: vector, rationale: '   ' },
            { ...AUTHOR_ATTR, why: 'seed: the score row carries no rationale' },
            [{ id: row.id, rev: moved.rev }]
        );

        expect(editorLockEvidenceOf(rig.store, rig.story(), premise.id)).toBeUndefined();

        // One non-blank character is enough: the rule is "a reason was given", never "the reason is good".
        const restored = rig.store.summaryScores.update(
            row.id,
            { rationale: 'x' },
            { ...AUTHOR_ATTR, why: 'seed: the rationale is present again' },
            [{ id: row.id, rev: rig.store.summaryScores.require(row.id).rev }]
        );

        expect(restored.rationale).toBe('x');
        expect(editorLockEvidenceOf(rig.store, rig.story(), premise.id)!.score.rationale).toBe('x');
    });

    it('refuses a section a live Writer is still installing over, and the seat returns when that run closes', async () => {
        const { rig, groups } = await armed();
        const tone = groups.find((group) => group.key === 'tone')!;

        const writer = liveWriterRun(rig, [tone.id]);

        expect(editorLockEvidenceOf(rig.store, rig.story(), tone.id)).toBeUndefined();
        expect(targetKeys(rig.store, rig.story())).toEqual(['premise', 'promise', 'theme', 'ending']);

        // CLOSED, so the install has landed (or failed): the read is about a pass still in flight, not
        // about the fact that a Writer once worked here — that fact is the clean selection's business.
        rig.store.runs.update(
            writer.id,
            { state: 'torn_down' satisfies Run['state'], ended_at: '2026-11-25T10:00:05.000Z' },
            { run_ref: writer.id, author: false, why: 'seed: the Writer pass closed' },
            [{ id: writer.id, rev: writer.rev }]
        );

        expect(editorLockEvidenceOf(rig.store, rig.story(), tone.id)!.group.key).toBe('tone');

        // A live holding run that names NO sections fails CLOSED: it holds every section, because the
        // conservative direction defers one sweep while the permissive one risks two installs at once.
        const unscoped = liveWriterRun(rig, []);

        expect(unscoped.group_refs).toEqual([]);
        expect(editorLockSeatTargets(rig.store, rig.story())).toEqual([]);
    });

    it('treats an already-locked section as the answer already given, and shows it as the fixed point to its neighbours', async () => {
        const { rig, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;

        lockPhraseGroup(
            rig.store,
            rig.story(),
            premise.id,
            { ...AUTHOR_ATTR, why: 'seed: the Author signed premise off by hand (R-lock)' },
            { actor: 'author', at: '2026-11-25T10:00:00.000Z' }
        );

        // Not offered: the flag IS a decision, and `lockPhraseGroup` would only refuse a second one.
        expect(editorLockEvidenceOf(rig.store, rig.story(), premise.id)).toBeUndefined();
        expect(targetKeys(rig.store, rig.story())).toEqual(['promise', 'theme', 'tone', 'ending']);

        // And the locked section still reaches the other seats as EVIDENCE: `locked_peers` carries the very
        // revision the selection stands behind, which is the text the prompt prints as the law.
        const tone = editorLockEvidenceOf(rig.store, rig.story(), idOf(rig.store, rig.storyId, 'tone'))!;

        expect(tone.locked_peers.map((entry) => `${entry.group.key}:${entry.revision.number}`)).toEqual(['premise:1']);
        expect(tone.unlocked_peers.map((group) => group.key)).toEqual(['promise', 'theme', 'ending']);
    });
});

// ---------------------------------------------------------------------------
// 3. The spent-seat read
// ---------------------------------------------------------------------------

describe('one decision per section per clean vector, scoped to the book (R3)', () => {
    it('is owed until any run answers that exact key, and a live answer counts too', async () => {
        const { rig, vector, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;
        const tone = groups.find((group) => group.key === 'tone')!;
        const evidence = editorLockEvidenceOf(rig.store, rig.story(), premise.id)!;
        const key = groupLockSeatKey(vector, premise.id);

        expect(evidence.vector_hash).toBe(vector);
        expect(groupLockSeatSpent(rig.store, evidence)).toBe(false);

        // A judgement still in flight already spent it: a second opinion on one freeze is the churn the
        // key exists to prevent, and a restart would otherwise re-queue the same question.
        const live = seatRun(rig, key, rig.storyId, 'reporting');

        expect(live.work_item_ref).toBe(key);
        expect(groupLockSeatSpent(rig.store, evidence)).toBe(true);

        // CLOSED is spent as well, whichever way the answer went — this read never looks at the payload,
        // because a `false` is a decision and not a failure.
        rig.store.runs.update(
            live.id,
            { state: 'torn_down' satisfies Run['state'], ended_at: '2026-11-25T10:00:06.000Z' },
            { run_ref: live.id, author: false, why: 'seed: the judgement pass closed' },
            [{ id: live.id, rev: live.rev }]
        );

        expect(groupLockSeatSpent(rig.store, evidence)).toBe(true);
        // Per KEY, never per book: the neighbour that nobody has decided is still owed its seat.
        expect(groupLockSeatSpent(rig.store, editorLockEvidenceOf(rig.store, rig.story(), tone.id)!)).toBe(false);
    });

    it('is not spent by another book\u2019s run on the same key, because the key carries no story id', async () => {
        const { rig, vector, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;
        const evidence = editorLockEvidenceOf(rig.store, rig.story(), premise.id)!;
        const key = groupLockSeatKey(vector, premise.id);

        // The hazard this read is written against: two books can hold the same 16-hex vector and the same
        // shaped group id, and an unscoped read would let one Story's judgement silence the other's seat.
        const other = seatRun(rig, key, 'story_9', 'torn_down');

        expect({ run_story: other.story_id, key: other.work_item_ref, evidence_story: evidence.group.story_id }).toEqual({
            run_story: 'story_9',
            key,
            evidence_story: rig.storyId
        });
        expect(groupLockSeatSpent(rig.store, evidence)).toBe(false);

        seatRun(rig, key, rig.storyId, 'torn_down');

        expect(groupLockSeatSpent(rig.store, evidence)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 4. The answer contract, at settle time
// ---------------------------------------------------------------------------

describe('the answer is validated against the seat that asked for it (R3, D-15)', () => {
    it('accepts a decision about the seat\u2019s own section, and trims the reason it will record', async () => {
        const { rig, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;

        expect(
            parseGroupLockAnswer(rig.store, rig.storyId, premise.id, {
                group_ref: premise.id,
                lock: true,
                rationale: '  no claim is open, and the section still commits to the map  '
            })
        ).toEqual({ ok: true, decision: { group_ref: premise.id, lock: true, rationale: 'no claim is open, and the section still commits to the map' } });

        // A refusal is a perfectly valid answer: the seat asked, the Editor said no, and the loop keeps
        // the section writable. Nothing downstream distinguishes the two shapes except `lock`.
        expect(
            parseGroupLockAnswer(rig.store, rig.storyId, premise.id, {
                group_ref: premise.id,
                lock: false,
                rationale: 'a proposal still asks this section to name the keeper'
            })
        ).toEqual({
            ok: true,
            decision: { group_ref: premise.id, lock: false, rationale: 'a proposal still asks this section to name the keeper' }
        });
    });

    it('refuses every answer the seat cannot be held to, with the sentence that says why', async () => {
        const { rig, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;
        const tone = groups.find((group) => group.key === 'tone')!;

        // The JOB was malformed (the loop's bug, not the model's): with no expected section there is
        // nothing to attribute an answer to, so the answer is refused before it is even read.
        expect(parseGroupLockAnswer(rig.store, rig.storyId, '', { group_ref: premise.id, lock: true, rationale: 'finished' })).toEqual({
            ok: false,
            refusal: 'the group-lock job named no group to decide on (WorkItem.groupRefs was empty), so no answer can be attributed'
        });

        // An invented id, and a missing one — the two ways a model can name a section this book has not.
        expect(parseGroupLockAnswer(rig.store, rig.storyId, premise.id, { group_ref: 'group_9', lock: true, rationale: 'finished' })).toEqual({
            ok: false,
            refusal: `the lock answer named "group_9", which is not a group of story ${rig.storyId} — and the seat asked about ${premise.id} (R-lock)`
        });
        expect(parseGroupLockAnswer(rig.store, rig.storyId, premise.id, { lock: true, rationale: 'finished' })).toEqual({
            ok: false,
            refusal: `the lock answer named "(no group_ref)", which is not a group of story ${rig.storyId} — and the seat asked about ${premise.id} (R-lock)`
        });

        // A REAL section, but not this seat's. Re-attributing it would freeze a section whose text the
        // pass was never shown, so the decision is refused whole — and stays unscheduled, so the section
        // it is about still gets its own seat.
        expect(parseGroupLockAnswer(rig.store, rig.storyId, premise.id, { group_ref: tone.id, lock: true, rationale: 'finished' })).toEqual({
            ok: false,
            refusal: `the lock answer decided tone (${tone.id}) while this seat was claimed for ${premise.id} — one seat decides one section, so a decision about another group is refused rather than re-attributed (R-lock)`
        });

        // A string is not a judgement: the transport may deliver `"true"`, and freezing a section on it
        // would be the loop guessing the model meant yes.
        expect(parseGroupLockAnswer(rig.store, rig.storyId, premise.id, { group_ref: premise.id, lock: 'true', rationale: 'finished' })).toEqual({
            ok: false,
            refusal: 'the lock answer for premise carried `lock: "true"` — a lock is a yes or a no, never a string or a number (R-lock)'
        });
        expect(parseGroupLockAnswer(rig.store, rig.storyId, premise.id, { group_ref: premise.id, rationale: 'finished' })).toEqual({
            ok: false,
            refusal: 'the lock answer for premise carried `lock: undefined` — a lock is a yes or a no, never a string or a number (R-lock)'
        });

        // D-15, both directions: the sentence has to be there whether the answer is a freeze or a refusal,
        // because the Author reads the reason either way.
        expect(parseGroupLockAnswer(rig.store, rig.storyId, premise.id, { group_ref: premise.id, lock: true, rationale: '  ' })).toEqual({
            ok: false,
            refusal:
                'the lock answer for premise said lock with no rationale — the decision has to name the claims it weighed and what settles them (D-15, R-lock)'
        });
        expect(parseGroupLockAnswer(rig.store, rig.storyId, premise.id, { group_ref: premise.id, lock: false, rationale: '' })).toEqual({
            ok: false,
            refusal:
                'the lock answer for premise said do not lock with no rationale — the decision has to name the claims it weighed and what settles them (D-15, R-lock)'
        });
    });
});

// ---------------------------------------------------------------------------
// 5. The guard the settle re-runs
// ---------------------------------------------------------------------------

describe('the guard re-reads the book inside the commit, one sentence per reason (R3)', () => {
    it('locks nothing on a key that is not a seat, and refuses a decision about the wrong section', async () => {
        const { rig, vector, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;
        const tone = groups.find((group) => group.key === 'tone')!;
        const decision = { group_ref: premise.id, lock: true as const, rationale: 'finished' };

        expect(editorLockGuardReason(rig.store, rig.story(), 'wi_review_groups_x_1', decision)).toBe(
            'wi_review_groups_x_1 is not a group-lock seat key, so its answer locks nothing'
        );
        // The seat's own copy of the target rule: `parseGroupLockAnswer` insists first, and this is the
        // belt-and-braces for a future caller that skips the parse.
        expect(editorLockGuardReason(rig.store, rig.story(), groupLockSeatKey(vector, premise.id), { ...decision, group_ref: tone.id })).toBe(
            `the answer decided ${tone.id} while the seat ${groupLockSeatKey(vector, premise.id)} was claimed for ${premise.id}`
        );
    });

    it('refuses when the permission was withdrawn while the seat was deliberating', async () => {
        const { rig, vector, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;
        const key = groupLockSeatKey(vector, premise.id);
        const decision = { group_ref: premise.id, lock: true as const, rationale: 'finished' };

        expect(editorLockGuardReason(rig.store, rig.story(), key, decision)).toBeUndefined();

        withLocking(rig.store, rig.storyId, false);

        expect(editorLockGuardReason(rig.store, rig.story(), key, decision)).toBe(
            `story ${rig.storyId} has \`editor_group_locking\` off (absent = disabled), so the Editor's decision does not lock ${premise.id}`
        );
    });

    it('refuses a seat whose section is gone from this book', async () => {
        const { rig, vector } = await armed();

        // An id with the right shape and no row: the seat key is reproducible from the vector alone, so a
        // scrapped catalog leaves keys behind, and a lock on a missing row would be an attribution on air.
        expect(editorLockGuardReason(rig.store, rig.story(), groupLockSeatKey(vector, 'group_9'), { group_ref: 'group_9', lock: true, rationale: 'x' })).toBe(
            'group_9 is not a phrase group of story ' + rig.storyId
        );
    });

    it('refuses a section the Author already locked, rather than re-dating the decision', async () => {
        const { rig, vector, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;

        lockPhraseGroup(
            rig.store,
            rig.story(),
            premise.id,
            { ...AUTHOR_ATTR, why: 'seed: the Author signed premise off by hand (R-lock)' },
            { actor: 'author', at: '2026-11-25T10:00:00.000Z' }
        );

        expect(editorLockGuardReason(rig.store, rig.story(), groupLockSeatKey(vector, premise.id), { group_ref: premise.id, lock: true, rationale: 'x' })).toBe(
            'premise is already locked at revision 1 by author — a second lock would only re-date a decision the book already carries'
        );
    });

    it('refuses a section with no written text, and one whose newest revision was never reviewed', async () => {
        const { rig, vector, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;
        const theme = groups.find((group) => group.key === 'theme')!;

        // The empty-canvas case the Seed reset produces: a flag here would freeze an empty section nobody
        // judged, which is the dangling lock the reset rule exists to prevent.
        const cleared = rig.store.phraseGroups.update(
            premise.id,
            { content: '', revision: 0, updated_by: null },
            { ...AUTHOR_ATTR, why: 'seed: the section was taken back to an empty canvas' },
            [{ id: premise.id, rev: premise.rev }]
        );

        expect(cleared.revision).toBe(0);
        expect(editorLockGuardReason(rig.store, rig.story(), groupLockSeatKey(vector, premise.id), { group_ref: premise.id, lock: true, rationale: 'x' })).toBe(
            'premise has no written text, so there is no revision for a lock to fix'
        );

        // The usual race: a Writer install lands under the pass. The clean selection still stands behind
        // revision 1, the row is at 2, and `lockPhraseGroup` fixes the ROW's number — the words nobody
        // reviewed. The sentence names both numbers, because that pair is the whole diagnosis.
        installOne(rig, theme.id, 'a rewritten theme.');

        expect(editorLockGuardReason(rig.store, rig.story(), groupLockSeatKey(vector, theme.id), { group_ref: theme.id, lock: true, rationale: 'x' })).toBe(
            'theme is at revision 2 while the clean selection stands behind 1 — the newest text was never reviewed, so it is not lockable'
        );
    });

    it('refuses when the reviewed Summary is gone or has moved, which is the seat judging a different book', async () => {
        // No complete selection at all: the same fixture one stamp short.
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 1, crew: { researchQuestions: [] } });

        installAll(rig, 'the installed text.');

        const old = vectorOf(rig.store, rig.storyId);
        const theme = groupsOf(rig.store, rig.storyId).find((group) => group.key === 'theme')!;

        for (const group of groupsOf(rig.store, rig.storyId)) scoreRowFor(rig, group, old);

        withLocking(rig.store, rig.storyId, true);

        expect(cleanSelectionOf(rig.store, rig.story()).complete).toBe(false);
        expect(editorLockGuardReason(rig.store, rig.story(), groupLockSeatKey(old, theme.id), { group_ref: theme.id, lock: true, rationale: 'x' })).toBe(
            `story ${rig.storyId} has no complete reviewed Summary any more, so the clean vector ${old} this seat judged is gone`
        );

        // Now clean, then a whole new round: every section at revision 2 behind a NEW selection. The seat's
        // key still names real rows, but the Overview it judged no longer exists, so the judgement is about
        // a different combination of texts. (The score rows still describe the old vector, and that clause
        // is the next test's — the vector check runs first, so the seat fails on the moved Overview.)
        stampClean(rig);
        installAll(rig, 'a rewritten round.', `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_2`);
        stampClean(rig, 'run_check_2');

        const fresh = cleanSelectionOf(rig.store, rig.story()).vector_hash;
        const themeNow = groupsOf(rig.store, rig.storyId).find((group) => group.key === 'theme')!;

        expect(fresh).not.toBe(old);
        expect(editorLockGuardReason(rig.store, rig.story(), groupLockSeatKey(old, themeNow.id), { group_ref: themeNow.id, lock: true, rationale: 'x' })).toBe(
            `the reviewed Summary moved from ${old} to ${fresh} between the seat's claim and its settle — the Editor judged a different Overview than the one the lock would fix`
        );
    });

    it('refuses when the Reader\u2019s reading has gone or carries no reason (D-65\u2019s exception)', async () => {
        const { rig, vector, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;
        const tone = groups.find((group) => group.key === 'tone')!;

        // The row scrapped or re-keyed (a scrap of the scoring pass): the seat adjudicates OVER a reading,
        // and with no reading there is nothing to adjudicate — the seat may not become a bare yes/no.
        const row = rig.store.summaryScores.list().find((score) => score.group_id === premise.id)!;

        rig.store.summaryScores.update(
            row.id,
            { vector_hash: 'eeeeeeeeeeeeeeee' },
            { ...AUTHOR_ATTR, why: 'seed: the score row left this vector' },
            [{ id: row.id, rev: row.rev }]
        );

        expect(editorLockGuardReason(rig.store, rig.story(), groupLockSeatKey(vector, premise.id), { group_ref: premise.id, lock: true, rationale: 'x' })).toBe(
            `premise has no Reader score at vector ${vector}, so the Editor's decision has no reading to weigh`
        );

        // The row is back at this vector but emptied of its reason — the guard checks the row the SEAT
        // names, deliberately without the eligibility read's rationale filter, so this branch exists to
        // catch the state the generator would already have skipped.
        const toneRow = rig.store.summaryScores.list().find((score) => score.group_id === tone.id)!;

        rig.store.summaryScores.update(
            toneRow.id,
            { rationale: '  ' },
            { ...AUTHOR_ATTR, why: 'seed: the score row lost its rationale' },
            [{ id: toneRow.id, rev: toneRow.rev }]
        );

        expect(editorLockGuardReason(rig.store, rig.story(), groupLockSeatKey(vector, tone.id), { group_ref: tone.id, lock: true, rationale: 'x' })).toBe(
            `the Reader's score for tone carries no rationale, and a lock may not rest on a bare number (D-65's exception is a judgement over the READING)`
        );
    });

    it('refuses under a live install, naming the run that would move the text', async () => {
        const { rig, vector, groups } = await armed();
        const ending = groups.find((group) => group.key === 'ending')!;
        const writer = liveWriterRun(rig, [ending.id]);

        expect(editorLockGuardReason(rig.store, rig.story(), groupLockSeatKey(vector, ending.id), { group_ref: ending.id, lock: true, rationale: 'x' })).toBe(
            `ending is being written by ${writer.id} — locking under a live install would leave the flag naming a text the Writer is still replacing`
        );
    });

    it('says nothing — the one state in which the settle may write — and reports the missing answer', async () => {
        const { rig, vector, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;
        const key = groupLockSeatKey(vector, premise.id);
        const decision = { group_ref: premise.id, lock: true as const, rationale: 'no claim is open, and the section still commits to the map' };

        expect(editorLockGuardReason(rig.store, rig.story(), key, decision)).toBeUndefined();
        // The engine's own call: an answer-less run is a refusal, not a lock, and the sentence is what the
        // journal would show if the settle ever logged it.
        expect(editorLockMayLock(rig.store, rig.story(), key, undefined)).toBe('the run left no structured lock answer');
        expect(editorLockMayLock(rig.store, rig.story(), key, decision)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 6. The fixed point, as the other prompts are shown it
// ---------------------------------------------------------------------------

describe('the locked peers, in catalog order, with the revision each lock fixed', () => {
    it('answers nothing on a book with no lock, and names both actors\u2019 locks with their numbers', async () => {
        const { rig, groups } = await armed();
        const premise = groups.find((group) => group.key === 'premise')!;
        const tone = groups.find((group) => group.key === 'tone')!;

        expect(lockedPeerLines(rig.store, rig.story())).toEqual([]);

        lockPhraseGroup(
            rig.store,
            rig.story(),
            premise.id,
            { run_ref: 'run_editor_judgement', author: false, why: 'seed: the Editor froze premise (R3)' },
            { actor: 'editor', at: '2026-11-25T10:00:00.000Z' }
        );
        lockPhraseGroup(
            rig.store,
            rig.story(),
            tone.id,
            { ...AUTHOR_ATTR, why: 'seed: the Author signed tone off (R-lock)' },
            { actor: 'author', at: '2026-11-25T10:00:01.000Z' }
        );

        // Catalog order, not lock order: the prompt renders these as the LAW, and one state has to compile
        // to one byte sequence (§5's cache rule).
        expect(
            lockedPeerLines(rig.store, rig.story()).map((line) => `${line.group.key}:${line.revision}:${line.locked_by}`)
        ).toEqual(['premise:1:editor', 'tone:1:author']);
    });

    it('falls back to the current revision and an author stamp on a row the loop never wrote', async () => {
        const { rig, groups } = await armed();
        const promise = groups.find((group) => group.key === 'promise')!;

        // A row locked by hand (`locked: true` with no metadata): the prompt may not print `undefined` for
        // the revision a peer has to match, so both reads fall back to the book's own truth — `revision`,
        // and the actor whose signature a lock without attribution can only be.
        const locked = rig.store.phraseGroups.update(
            promise.id,
            { locked: true },
            { ...AUTHOR_ATTR, why: 'seed: a lock row with no metadata' },
            [{ id: promise.id, rev: promise.rev }]
        );

        expect({ locked: locked.locked, locked_revision: locked.locked_revision, locked_by: locked.locked_by }).toEqual({
            locked: true,
            locked_revision: undefined,
            locked_by: undefined
        });
        expect(lockedPeerLines(rig.store, rig.story())).toEqual([{ group: locked, revision: 1, locked_by: 'author' }]);
    });
});
