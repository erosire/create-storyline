/**
 * HARDENING (items 1–2) — the tool layer's refusals on a GROUP-managed book, pinned at the exact copy
 * the crew reads, with the legacy book pinned alongside them.
 *
 * What each pin exists to prevent:
 *
 *   1. `tools/reader.ts`'s unknown-group-id fix line used to tell EVERY book "omit group_refs when the
 *      defect is the whole Overview" — but on a grouped book omission is refused by the rule one line
 *      below, so the structured advice contradicted the refusal the crew had just been handed. The
 *      grouped fix line must say the truth instead: a cross-Overview defect NAMES every affected group
 *      (all 5 for a whole-Overview claim); there is no unscoped path. The legacy fix line keeps the
 *      omission meaning, which is correct there (that book has no groups at all). (The unknown-id
 *      refusals themselves are pinned in `reader-group-attribution.test.ts`; only the `fix` detail is
 *      re-pinned here — see its two `fix` assertions.)
 *   2. `tools/editor.ts`'s `requestMerge` D-23 refusal branched its MESSAGE by pipeline but told BOTH
 *      books `listRevisions …, then selectRevision` — sending a grouped book straight at the selection
 *      workflow the redesign removed (R2/R5). Message and `fix` now branch together.
 *   3. `selectRevision` on a grouped Summary is refused outright (R5): the group model has no draft to
 *      select, and installing a legacy draft would write the mirror text the group rows do not hold.
 *   4. `editSummary` on a grouped book is refused outright (R6): the five prose fields are the MIRROR
 *      `installGroupRevisions` writes in the install's own commit; a hand write made the mirror a
 *      SECOND write path — the Overview drifting from the groups that compose it. The refusal names
 *      both real doors: the grouped `draft_groups` job and the per-group revise route. NOTHING moves
 *      when it refuses (P1): content, group rows, revisions and history all keep their exact values.
 *   5. The legacy sampling book is unchanged in every case: the same writes, the same fix copy.
 *
 * FIXTURE: the same `run/mock.ts:seedStory` + `phrase/catalog.ts:ensurePhraseCatalog` rig as
 * `reader-group-attribution.test.ts` — `recordUidAt(1)` is the Phrase row, `recordUidAt(2..6)` the
 * five groups in catalog order — so every id below is a literal a reader can point at. Refusals carry
 * the `tools/index.ts` prefix (`Rule: <id> — `), and refusal DETAILS spread onto the result
 * (`utilities.ts:refusalResult`), so `fix` is asserted from the result row.
 */
import { describe, expect, it } from 'vitest';

import { installGroupRevisions } from '../phrase/revisions';
import { ensurePhraseCatalog } from '../phrase/catalog';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { Store } from '../store';
import { recordUidAt } from '../store/persist';
import { createToolRuntime } from './index';
import type { PhraseGroup, Story } from '../../shared/types';
import type { RunSession, RunToolContext, ToolRuntime } from './index';

interface Book {
    store: Store;
    story: Story;
    groups: PhraseGroup[];
    runtime: ToolRuntime;
    contexts: Record<'writer' | 'editor' | 'critic', RunToolContext>;
}

const idOf = (groups: PhraseGroup[], key: string) => groups.find((group) => group.key === key)!.id;

const sessionFor = (storyId: string, kind: 'writer' | 'editor' | 'critic'): RunSession => ({
    storyId,
    roleKind: kind,
    roleName: kind,
    runId: `run_${kind}`
});

/** A phase-① book on either pipeline — the switch set BEFORE the catalog, exactly as the store's rule reads it. */
function seedBook(summaryMode: 'groups' | 'sampling', withHistory = false): Book {
    const store = Store.empty();
    const seeded = seedStory(store, { phase: 'summary' });
    const story = store.stories.update(
        seeded.id,
        { summary_mode: summaryMode },
        { run_ref: null, author: true, why: 'seed: the Summary pipeline under test (R1)' },
        [{ id: seeded.id, rev: seeded.rev }]
    );

    let next = 1;
    const groups =
        summaryMode === 'groups'
            ? ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!.groups
            : [];

    // R2 history, when the test asks for it: one accepted install — five `latest` group revisions at
    // number 1, the Overview composed, the mirror written in the same commit. This is the state a
    // hand-write refusal has to leave EXACTLY as it found.
    if (groups.length > 0 && withHistory) {
        installGroupRevisions(
            store,
            story,
            groups.map((group) => ({ group, content: `${group.key}: the installed text.` })),
            AUTHOR_ATTR,
            { runRef: 'run_writer', workItemRef: 'wi_draft_groups_summary_0_hash_1' }
        );
    }

    const runtime = createToolRuntime(store);

    return {
        store,
        story,
        groups,
        runtime,
        contexts: {
            writer: runtime.createContext(sessionFor(story.id, 'writer')),
            editor: runtime.createContext(sessionFor(story.id, 'editor')),
            critic: runtime.createContext(sessionFor(story.id, 'critic'))
        }
    };
}

const refusal = (rule: string, message: string) => `Rule: ${rule} — ${message}`;

/** The book's state as one snapshot, so "nothing moved" is ONE exact assertion, not four guards. */
const snapshot = (book: Book) => ({
    summaries: book.store.summaries.list().map((row) => ({ ...row })),
    phrases: book.store.phrases.list().map((row) => ({ ...row })),
    groups: book.store.phraseGroups.list().map((row) => ({ ...row })),
    groupRevisions: book.store.groupRevisions.list().map((row) => ({ ...row })),
    revisions: book.store.revisions.list().map((row) => ({ ...row })),
    journal: book.store.journal.filter((event) =>
        ['summaries', 'phrases', 'phrase_groups', 'group_revisions', 'revisions'].includes(event.collection)
    )
});

describe('a grouped book is never directed at the removed selection workflow (D-23, R2/R5)', () => {
    it('refuses requestMerge with the group branch of the message AND the group door in the fix', async () => {
        const book = seedBook('groups');
        const result = await book.runtime.execute(book.contexts.editor, 'requestMerge', {
            unit_ref: 'summary_0',
            revision_ids: ['revision_0', 'revision_1'],
            parts: 'the opening of one, the promise of the other',
            why: 'both drafts are good at different things'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('D-23');
        expect(result.message).toBe(
            refusal(
                'D-23',
                'phase ① chooses one best Summary; it does not merge drafts — on a book written group by group there is nothing to select, because each group is installed as its own revision (R2, R5), so raise a finding naming the groups instead'
            )
        );
        // The structured advice branches WITH the message — `listRevisions/selectRevision` is exactly
        // the workflow this branch says is gone.
        expect((result as { fix?: string }).fix).toBe(
            'raiseFinding with group_refs naming every group the defect crosses — the grouped draft_groups job installs the fix'
        );
    });

    it('keeps the whole-Summary book its own message and its listRevisions fix (legacy unchanged)', async () => {
        const book = seedBook('sampling');
        const result = await book.runtime.execute(book.contexts.editor, 'requestMerge', {
            unit_ref: 'summary_0',
            revision_ids: ['revision_0', 'revision_1'],
            parts: 'the opening of one, the promise of the other',
            why: 'both drafts are good at different things'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('D-23');
        expect(result.message).toBe(
            refusal(
                'D-23',
                'phase ① chooses one best Summary; it does not merge drafts — call selectRevision on exactly one, or rejectAll if none deserves the Author (D-23)'
            )
        );
        expect((result as { fix?: string }).fix).toBe('listRevisions summary_0, then selectRevision');
    });

    it('refuses selectRevision on the grouped Summary and moves nothing (R5)', async () => {
        const book = seedBook('groups', true);
        const before = snapshot(book);

        const result = await book.runtime.execute(book.contexts.editor, 'selectRevision', {
            unit_ref: 'summary_0',
            revision_id: 'revision_0',
            selection_note: 'the Seed pays the promise'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('R5');
        expect(result.message).toBe(
            refusal(
                'R5',
                'this book writes its Summary group by group, so there is no Summary draft to select: each group installs its own revision and the install recomposes the Overview (R2, R5). Raise a finding naming the groups the defect crosses and let the grouped draft job fix them.'
            )
        );
        expect((result as { fix?: string }).fix).toBe(
            'raiseFinding with group_refs naming every group the defect crosses — the grouped draft_groups job installs the fix'
        );
        expect((result as { unit_ref?: string }).unit_ref).toBe('summary_0');
        expect(snapshot(book)).toEqual(before);
    });
});

describe('the mirror is the install\u2019s, not a second write path (R6)', () => {
    it('refuses a hand editSummary on the grouped book and names BOTH real doors', async () => {
        const book = seedBook('groups', true);
        const before = snapshot(book);

        const result = await book.runtime.execute(book.contexts.writer, 'editSummary', {
            premise: 'A hand-written premise the groups never said.',
            // `editSummary` is read-modify-write (T-4): the crew sends the expects its read produced,
            // so the refusal under test is R6 and not the runtime's missing-expects rule.
            expects: [{ id: 'summary_0', rev: book.store.summaries.require('summary_0').rev }],
            why: 'I want to fix the premise line directly'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('R6');
        expect(result.message).toBe(
            refusal(
                'R6',
                `this book writes its Summary group by group, so these prose fields are the MIRROR of its phrase groups — the install writes them, and a hand write would put the Overview out of step with the groups it composes (R6). Draft the groups with the \`draft_groups\` job, or revise one group: POST /stories/${book.story.id}/phrases/groups/{group_id}/revise.`
            )
        );
        expect((result as { fix?: string }).fix).toBe(
            'run the grouped draft_groups job, or call the per-group revise route — the mirror follows the installed group texts'
        );
        expect((result as { summary_mode?: string }).summary_mode).toBe('groups');

        // Nothing moved (P1): the mirror, the group rows, the Overview and the revision history all
        // keep the exact values the install wrote.
        expect(before.summaries).toHaveLength(1);
        expect(before.groupRevisions.map((row) => row.number)).toEqual([1, 1, 1, 1, 1]);
        expect(snapshot(book)).toEqual(before);
    });

    it('leaves the legacy sampling book the same whole-Summary write it always had', async () => {
        const book = seedBook('sampling');
        const before = book.store.summaries.require('summary_0');

        const result = await book.runtime.execute(book.contexts.writer, 'editSummary', {
            premise: 'A return, on foot.',
            expects: [{ id: 'summary_0', rev: before.rev }],
            why: 'the Author wants the premise stated plainly'
        });

        expect(result.ok).toBe(true);
        expect((result as { data?: Record<string, unknown> }).data).toMatchObject({
            id: 'summary_0',
            fields_written: ['premise'],
            current_rev: before.rev + 1
        });

        const after = book.store.summaries.require('summary_0');

        expect(after.premise).toBe('A return, on foot.');
        expect(after.rev).toBe(before.rev + 1);
    });
});

describe('the unknown-group fix line matches the book\u2019s pipeline (R3, item 1)', () => {
    // The refusal MESSAGES of these two calls are already pinned verbatim in
    // `reader-group-attribution.test.ts`; this pins the structured `fix` the crew acts on, which is
    // what the hardening changed.
    const unknownFiling = (refs: string[]) => ({
        target_ref: 'summary_0',
        criterion_ref: 'C-14',
        title: 'the Overview promises a cartographer the Seed destroyed',
        detail: 'summary_0 promise keeps the cartographer; the Seed says the map was destroyed',
        evidence: 'summary_0 promise: "the cartographer returns to the valley"',
        cost: 'major',
        group_refs: refs
    });

    it('tells a grouped book to name every affected group — no unscoped path', async () => {
        const book = seedBook('groups');
        const result = await book.runtime.execute(book.contexts.critic, 'raiseFinding', unknownFiling([recordUidAt(0)]));

        expect(result.ok).toBe(false);
        expect((result as { fix?: string }).fix).toBe(
            'call raiseFinding again with group_refs naming every group the defect crosses — a whole-Overview defect names all 5 ids listed; this book has no unscoped Summary path'
        );
        expect((result as { expected?: string[] }).expected).toEqual(book.groups.map((group) => group.id));
    });

    it('tells a group-less book to omit group_refs, which is its whole-Overview meaning', async () => {
        const book = seedBook('sampling');
        const result = await book.runtime.execute(book.contexts.critic, 'raiseFinding', unknownFiling([recordUidAt(1)]));

        expect(result.ok).toBe(false);
        expect((result as { fix?: string }).fix).toBe(
            'omit group_refs — this book has no phrase groups, so its Summary is one whole text'
        );
    });

    it('keeps the must-name-groups refusal fix pointed at the ids, not at omission', async () => {
        const book = seedBook('groups');
        const result = await book.runtime.execute(book.contexts.critic, 'raiseFinding', {
            ...unknownFiling([]),
            group_refs: undefined
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('R3');
        expect((result as { fix?: string }).fix).toBe(
            'call raiseFinding again with group_refs naming every group the defect crosses'
        );
    });

    void idOf;
});
