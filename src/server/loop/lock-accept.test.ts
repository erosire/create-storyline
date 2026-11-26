// T12 / R3 — "accept the final Summary" stops the Summary phrase's outstanding work, IN THE LOCK COMMIT.
//
// WHAT THIS FILE PINS, and why each is a rule rather than an implementation detail:
//
//   1. THE VOID IS A STATE CHANGE, NEVER A ROW DELETE. `documents/specifications.md` (D-36) pins that a
//      lock deletes the Ideas TRAY while its FINDINGS survive as provenance (P11), so an accepted Summary
//      must move a claim to `discarded` and keep the row: the Author keeps the record of what the crew said
//      about the book, and the queue still empties. The row COUNT is therefore part of the assertion.
//   2. THE SCOPE IS THE PHRASE, NOT THE STORY (R3). A claim that names only Phrase ②'s chapter entries is
//      live work for the phrase this same accept starts, and one that names groups in both phrases keeps
//      its Phrase ② half. Over-voiding is the failure mode, so the surviving rows are asserted as exactly
//      as load-bearing as the voided ones.
//   3. THE TERMINAL LADDER IS NOT RE-DECIDED HERE. `fixed` and `discarded` are closed in §4.10 and stay
//      exactly where they are; `disputed` moves because D-33c counts a dispute as an open claim. Both facts
//      come from `phrase/locks.ts:VOIDABLE_FINDING_STATES` — the accept calls the SAME void path a group
//      lock uses, so the two can never disagree about what "void" means.
//   4. THE COUNTS ARE THE RECEIPT (L-25b: "whatever is still open at that moment is discarded by the act of
//      completing, and the count is recorded"). `lockWrites` answers them from inside the commit, and the
//      `plotlines`/`chapters` legs answer WITHOUT those keys — a zero there would report a decision that
//      was never taken.
//   5. THE TASKS GO THROUGH `records.ts:wontfixTasks` (the L-36 path): `wontfix` for `open` and `claimed`,
//      and a `done`/`wontfix`/`blocked` row untouched — §4.7's ladder, not a cleared queue.
//
// THE FIXTURES: `ensurePhraseCatalog` is the domain's own create path (the real five groups, in catalog
// order), and the Plotlines rows are hand-seeded because a started Phrase ② is not what this file is about
// — only the group NAMESPACE a finding's `group_refs` may name.
import { describe, expect, it } from 'vitest';
import { PHRASE_PLOTLINES_KEY } from '../../shared/phrase';
import type {
    Cost,
    Finding,
    FindingState,
    Phrase,
    PhraseGroup,
    Story,
    StoryPhase,
    Task,
    TaskState
} from '../../shared/types';
import { ensurePhraseCatalog } from '../phrase';
import { Store } from '../store/store';
import { lockWrites } from './invalidation';
import type { PhaseLockReceipt } from './types';

/** The fixed clock every assertion names, so the journal's `at` is a known string. */
const AT = '2026-11-11T10:00:00.000Z';

/** §4.1's defaults, spelled out because the store keeps whatever it is handed (as in `./d36-tray.test.ts`). */
function seedStory(store: Store, phase: StoryPhase): Story {
    return store.stories.create(
        {
            title: 'The Light Keeper',
            phase,
            idea: 'A lighthouse keeper learns the light was never the point.',
            summary_locked: phase !== 'summary',
            plotlines_locked: false,
            pending_kind: 'none',
            status: 'ready',
            trend: 'unknown',
            auto_approve: ['critical'],
            author_stop: false,
            digest_rev: 0,
            template_refs: [],
            chapter_deps: {},
            // T12's leftover sweep is scoped to the phrase, so the book has to be the phrase's own.
            summary_mode: 'groups',
            plotlines_mode: 'groups'
        },
        { why: 'seed: story created' }
    ) as Story;
}

/** The Summary Phrase and its five groups, through the domain operation the create route uses. */
function seedSummaryPhrase(store: Store, story: Story): Map<string, PhraseGroup> {
    const ensured = ensurePhraseCatalog(store, story, { why: 'seed: the phrase catalog' })!;

    return new Map(ensured.groups.map((group) => [group.key, group] as [string, PhraseGroup]));
}

/** One Phrase ② chapter entry, hand-seeded: the point is the group NAMESPACE, not the started phrase. */
function seedChapterGroup(store: Store, story: Story, order = 1): PhraseGroup {
    const phrase = store.phrases.create(
        {
            story_id: story.id,
            key: PHRASE_PLOTLINES_KEY,
            title: 'Plotlines Phrase',
            description: 'One entry per chapter.',
            content: '',
            order: 2,
            revision: 0,
            group_refs: [],
            seed: 'A compiled Summary, copied.'
        },
        { why: 'seed: the plotlines phrase' }
    ) as Phrase;

    return store.phraseGroups.create(
        {
            story_id: story.id,
            phrase_id: phrase.id,
            key: `chapter_${order}`,
            title: `Chapter ${order}`,
            description: 'The chapter contract.',
            order,
            content: `Chapter ${order} text.`,
            revision: 1
        },
        { why: 'seed: the chapter entry' }
    ) as PhraseGroup;
}

/** One §4.10 finding; the store mints the ids, so call order names them exactly (`finding_0`…). */
function seedFinding(
    store: Store,
    story: Story,
    state: FindingState,
    cost: Cost,
    groupRefs?: string[]
): Finding {
    return store.findings.create(
        {
            story_id: story.id,
            target_ref: 'summary_0',
            criterion_ref: 'C-1',
            title: `A ${state} claim`,
            evidence: 'a line of the Overview contradicts another',
            cost,
            fingerprint: `fp_${state}_${groupRefs?.join('_') || 'unscoped'}`,
            state,
            seen_count: 1,
            ...(groupRefs === undefined ? {} : { group_refs: groupRefs })
        },
        { why: `seed: ${state} finding` }
    ) as Finding;
}

/** One §4.7 task in one state; ids follow creation order (`task_0`…). */
function seedTask(store: Store, story: Story, state: TaskState, kind = 'fix'): Task {
    return store.tasks.create(
        {
            story_id: story.id,
            kind,
            title: `A ${state} ${kind}`,
            state,
            priority: 1,
            attempts: 0
        },
        { why: `seed: ${state} task` }
    ) as Task;
}

/** `[id, state]` of every finding, id order — "what survived" as an exact value. */
const findingStates = (store: Store): Array<[string, FindingState]> =>
    store.findings.list().map((finding) => [finding.id, finding.state] as [string, FindingState]);

/** `[id, state]` of every task, id order. */
const taskStates = (store: Store): Array<[string, TaskState]> =>
    store.tasks.list().map((task) => [task.id, task.state] as [string, TaskState]);

/** Every journal line one commit label wrote, in order: the audit is part of the rule (P11). */
const journalLines = (store: Store, label: string) =>
    store.journal
        .filter((event) => event.commit_label === label)
        .map((event) => ({
            collection: event.collection,
            op: event.op,
            id: event.id,
            attribution: event.attribution
        }));

/**
 * Runs the lock the way the ENGINE runs it — inside one `lock_phase` commit — and hands back the receipt.
 *
 * Not decoration: the D-36/P11 assertions below read the journal BY COMMIT LABEL, and a bare
 * `lockWrites` call lands its rows under `update:findings`-style labels (see `store/store.ts`), so an
 * uncommitted call could not tell an Author "the lock did this" from "a seed wrote this".
 */
async function lockPhaseWrites(store: Store, story: Story, phase: StoryPhase): Promise<PhaseLockReceipt> {
    let receipt: PhaseLockReceipt = { deleted_ideas: 0, next_phase: null };

    await store.commit('lock_phase', () => {
        receipt = lockWrites(store, story, phase, AT);
    });

    return receipt;
}

describe('T12 / R3 â the Summary accept voids the phrase’s open findings in the lock commit', () => {
    it('voids the Summary’s open claims, spares the closed ones and Phrase â¡’s, and reports the count', async () => {
        const store = Store.empty();
        const story = seedStory(store, 'summary');
        const groups = seedSummaryPhrase(store, story);
        const chapter = seedChapterGroup(store, story);

        seedFinding(store, story, 'confirmed', 'major'); // finding_0 — unscoped: the legacy whole-Overview claim
        seedFinding(store, story, 'approved', 'minor', [groups.get('premise')!.id]); // finding_1 — one Summary group
        seedFinding(store, story, 'unconfirmed', 'taste'); // finding_2 — a suspicion, still a live claim
        seedFinding(store, story, 'disputed', 'major'); // finding_3 — D-33c counts a dispute OPEN
        seedFinding(store, story, 'fixed', 'critical'); // finding_4 — terminal, untouched
        seedFinding(store, story, 'discarded', 'critical'); // finding_5 — terminal, untouched
        // finding_6 — Phrase ②'s alone: the accept is starting that phrase, its claim stays work.
        seedFinding(store, story, 'confirmed', 'major', [chapter.id]);
        // finding_7 — mixed scope: its Phrase ② half is still writable, so the whole row stays open (R3).
        seedFinding(store, story, 'confirmed', 'major', [groups.get('ending')!.id, chapter.id]);

        expect(await lockPhaseWrites(store, story, 'summary')).toEqual({
            deleted_ideas: 0,
            next_phase: 'plotlines',
            voided_findings: 4,
            wontfixed_tasks: 0
        });

        expect(findingStates(store)).toEqual([
            ['finding_0', 'discarded'],
            ['finding_1', 'discarded'],
            ['finding_2', 'discarded'],
            ['finding_3', 'discarded'],
            ['finding_4', 'fixed'],
            ['finding_5', 'discarded'],
            ['finding_6', 'confirmed'],
            ['finding_7', 'confirmed']
        ]);

        // P11: the void is a state change. A deleted row would take the crew's claim with it, and D-36 pins
        // that only the Ideas tray goes.
        expect(store.findings.list()).toHaveLength(8);

        // Every void is journaled with the accept's sentence, and the sentence names the reason the claim
        // died — the audit an Author reads when the rail goes quiet.
        expect(
            journalLines(store, 'lock_phase')
                .filter((event) => event.collection === 'findings')
                .map((event) => ({ id: event.id, why: (event.attribution as { why: string }).why }))
        ).toEqual([
            {
                id: 'finding_0',
                why: `the Author accepted the Summary at ${AT} (L-7a, T12); discarded finding_0 because it named no group and the Overview it was raised against is now signed off (summary accept)`
            },
            {
                id: 'finding_1',
                why: `the Author accepted the Summary at ${AT} (L-7a, T12); discarded finding_1 because every group it names (premise) is settled text the accept will not rewrite (summary accept)`
            },
            {
                id: 'finding_2',
                why: `the Author accepted the Summary at ${AT} (L-7a, T12); discarded finding_2 because it named no group and the Overview it was raised against is now signed off (summary accept)`
            },
            {
                id: 'finding_3',
                why: `the Author accepted the Summary at ${AT} (L-7a, T12); discarded finding_3 because it named no group and the Overview it was raised against is now signed off (summary accept)`
            }
        ]);
    });

    it('a book with no Phrase â  row still voids its unscoped claims â the legacy meaning is the Summary’s', async () => {
        const store = Store.empty();
        const story = seedStory(store, 'summary');

        seedFinding(store, story, 'confirmed', 'major'); // finding_0
        seedFinding(store, story, 'approved', 'minor', ['grp-missing']); // finding_1 — a ref this book lacks

        expect(await lockPhaseWrites(store, story, 'summary')).toEqual({
            deleted_ideas: 0,
            next_phase: 'plotlines',
            voided_findings: 2,
            wontfixed_tasks: 0
        });
        expect(findingStates(store)).toEqual([
            ['finding_0', 'discarded'],
            ['finding_1', 'discarded']
        ]);
    });
});

describe('T12 / R3 â the accept closes the phrase’s open tasks as `wontfix`', () => {
    it('closes `open` and `claimed`, leaves `done`/`wontfix`/`blocked` alone, and reports the count', async () => {
        const store = Store.empty();
        const story = seedStory(store, 'summary');

        seedSummaryPhrase(store, story);
        seedTask(store, story, 'open'); // task_0
        seedTask(store, story, 'claimed'); // task_1 — a claimed job the accept stops mid-flight
        seedTask(store, story, 'done'); // task_2
        seedTask(store, story, 'wontfix'); // task_3
        seedTask(store, story, 'blocked', 'author_question'); // task_4 — an Author question, not a queued job

        expect(await lockPhaseWrites(store, story, 'summary')).toEqual({
            deleted_ideas: 0,
            next_phase: 'plotlines',
            voided_findings: 0,
            wontfixed_tasks: 2
        });
        expect(taskStates(store)).toEqual([
            ['task_0', 'wontfix'],
            ['task_1', 'wontfix'],
            ['task_2', 'done'],
            ['task_3', 'wontfix'],
            ['task_4', 'blocked']
        ]);

        expect(
            journalLines(store, 'lock_phase')
                .filter((event) => event.collection === 'tasks')
                .map((event) => ({ id: event.id, attribution: event.attribution }))
        ).toEqual([
            {
                id: 'task_0',
                attribution: {
                    run_ref: null,
                    author: true,
                    why: `the Author accepted the Summary at ${AT}; its open tasks are wontfix because the phrase is complete (T12, R3)`
                }
            },
            {
                id: 'task_1',
                attribution: {
                    run_ref: null,
                    author: true,
                    why: `the Author accepted the Summary at ${AT}; its open tasks are wontfix because the phrase is complete (T12, R3)`
                }
            }
        ]);

        // The finding behind a closed task is NOT discarded by the task sweep (L-36's rule, kept exactly):
        // the task says the work will not be done; only the void path decides a claim's state.
        expect(findingStates(store)).toEqual([]);
    });
});

describe('T12 / R3 — a plotlines or chapters lock is the same sign-off it always was', () => {
    /** A book with the accept's leftovers already sitting on it, one phase further along. */
    function seededLaterPhaseStore(phase: 'plotlines' | 'chapters'): { store: Store; story: Story } {
        const store = Store.empty();
        const story = seedStory(store, phase);
        const groups = seedSummaryPhrase(store, story);

        seedFinding(store, story, 'confirmed', 'major'); // finding_0 — unscoped, so a legacy sweep WOULD take it
        seedFinding(store, story, 'disputed', 'major', [groups.get('premise')!.id]); // finding_1
        seedFinding(store, story, 'fixed', 'critical'); // finding_2
        seedTask(store, story, 'open'); // task_0
        seedTask(store, story, 'claimed'); // task_1

        return { store, story };
    }

    it('locking the plotlines voids nothing, closes no task, and reports only what that leg did', async () => {
        const { store, story } = seededLaterPhaseStore('plotlines');

        // No `voided_findings`/`wontfixed_tasks` KEYS at all: absent means that leg writes no such rows,
        // and a zero would report a decision the Author never took.
        expect(await lockPhaseWrites(store, story, 'plotlines')).toEqual({
            deleted_ideas: 0,
            next_phase: 'chapters'
        });
        expect(findingStates(store)).toEqual([
            ['finding_0', 'confirmed'],
            ['finding_1', 'disputed'],
            ['finding_2', 'fixed']
        ]);
        expect(taskStates(store)).toEqual([
            ['task_0', 'open'],
            ['task_1', 'claimed']
        ]);
        expect(journalLines(store, 'lock_phase').filter((event) => event.collection === 'findings')).toEqual([]);
        expect(journalLines(store, 'lock_phase').filter((event) => event.collection === 'tasks')).toEqual([]);
    });

    it('locking the chapters (the completion, L-25a) changes no finding and no task either', async () => {
        const { store, story } = seededLaterPhaseStore('chapters');

        expect(await lockPhaseWrites(store, story, 'chapters')).toEqual({
            deleted_ideas: 0,
            next_phase: null
        });
        expect(findingStates(store)).toEqual([
            ['finding_0', 'confirmed'],
            ['finding_1', 'disputed'],
            ['finding_2', 'fixed']
        ]);
        expect(taskStates(store)).toEqual([
            ['task_0', 'open'],
            ['task_1', 'claimed']
        ]);
    });
});

describe('T12 — the summary leg keeps the D-36 tray delete it already had', () => {
    it('empties the tray AND sweeps the leftovers in ONE call, and the counts are independent', async () => {
        const store = Store.empty();
        const story = seedStory(store, 'summary');

        seedSummaryPhrase(store, story);
        store.ideas.create(
            {
                story_id: story.id,
                phase: 'summary',
                body: 'Send the keeper away in chapter two.',
                kind: 'direction',
                author: 'critic_1',
                sources: [],
                fingerprint: 'fp_chapter_two',
                seen_count: 1,
                state: 'selected'
            },
            { why: 'seed: selected idea' }
        );
        seedFinding(store, story, 'confirmed', 'major'); // finding_0
        seedTask(store, story, 'open'); // task_0

        expect(await lockPhaseWrites(store, story, 'summary')).toEqual({
            deleted_ideas: 1,
            next_phase: 'plotlines',
            voided_findings: 1,
            wontfixed_tasks: 1
        });
        expect(store.ideas.list()).toEqual([]);
        expect(findingStates(store)).toEqual([['finding_0', 'discarded']]);
        expect(taskStates(store)).toEqual([['task_0', 'wontfix']]);

        // The order inside the commit is the order the decision was taken: the Story's flag, the tray (D-36),
        // then the leftovers the accept swallows, findings before tasks. `summaries` is absent because this
        // book has no legacy row, and the phase move is the ENGINE's line (`lockPhase` writes it after this
        // function returns), so it is not part of what `lockWrites` itself orders.
        expect(journalLines(store, 'lock_phase').map((event) => `${event.collection}:${event.op}`)).toEqual([
            'stories:update',
            'ideas:delete',
            'findings:update',
            'tasks:update'
        ]);
    });
});
