// T5 / R1 — the LOCK WORD on the rail: the row that says "this group is settled" and nothing else.
//
// The rail is 320px and the pane is where the decision happens, so the row's whole job is to be legible DOWN the
// list: one word, `Locked`, after the group's title, and the two facts that do not fit (WHICH revision is settled
// and WHO settled it) ride the row's own `title`. Three failure modes this file exists to catch:
//
//   1. THE WORD JOINING THE TITLE — an accessible name built from text nodes, so a missing separator reads
//      "PremiseLocked" to a screen reader (the exact defect T5 pinned for the discarded row, and the rule R6
//      pins for the state word). The name is asserted WHOLE, so a lost space fails loudly.
//   2. THE MARK MOVING THE FACTS IT SHOULD NOT — the findings badge and the score stay where they were, in the
//      same rows, with the same numbers. A lock that pushed the score out of the row is a rail that stopped
//      reporting the Reader's mark.
//   3. THE MARK DISAGREEING WITH THE PANE — both read `story-nav.summaryGroupEntries`, which reads the phrase
//      rows, so the revision and the actor in the tooltip are the same two facts the pane's badge prints
//      (`story-contract.groupLockBadge`). An actor the wire never named says `by crew`, never a guessed author.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StoryOutline } from './StoryOutline';
import { DEFAULT_STORY_SELECTION } from './story-nav';
import { fixturePhrase, fixtureView } from './story-fixtures';
import type { PhraseGroupRow, PhraseView } from '../api';

/**
 * The fixture's grouped book with two locks on it, chosen to cover both actors and both empty cases:
 *
 *   - `grp-premise` — locked by the AUTHOR on Revision 3, the row that also carries a findings badge AND a score,
 *     so a lock cannot silently drop either;
 *   - `grp-theme` — locked by the EDITOR (only possible with the R2 Setting on) on its own single revision, and
 *     already marked `writer` in the row: lock word, state word, badge and score all in one row;
 *   - `grp-tone` — locked with NO `locked_by` at all: a row written before the actor field existed, which must say
 *     `by crew` rather than guess;
 *   - `grp-promise` / `grp-ending` — open, and the pair that proves the mark is not a per-book flag.
 */
function lockedGroups(overrides: Partial<PhraseView> = {}): PhraseView {
    const phrase = fixturePhrase();
    const lock = (row: PhraseGroupRow, patch: Partial<PhraseGroupRow>): PhraseGroupRow => ({
        ...row,
        locked: true,
        locked_revision: row.revision,
        ...patch
    });

    return {
        ...phrase,
        groups: phrase.groups.map((row) => {
            if (row.key === 'premise') {
                return lock(row, { locked_revision: 3, locked_by: 'author', locked_at: '2026-11-11T11:40:00.000Z' });
            }

            if (row.key === 'theme') {
                return lock(row, { locked_by: 'editor', locked_at: '2026-11-11T11:42:00.000Z' });
            }

            // The legacy lock: the row says the group is settled and names NO actor, so `locked_by` is absent
            // rather than null — the shape a projection written before the field existed actually sends.
            if (row.key === 'tone') {
                return { ...row, locked: true, locked_revision: row.revision };
            }

            return { ...row, locked: false };
        }),
        ...overrides
    };
}

/** The Summary phrase's rows as (title, lock word, state word, badge, score) — the whole list, so a mark in the wrong row fails. */
function rowsOfSummary(container: HTMLElement): Array<Array<string | null>> {
    const summary = Array.from(container.querySelectorAll<HTMLElement>('.outline-phase')).find((element) =>
        element.textContent?.includes('Summary')
    )!;

    return Array.from(summary.querySelectorAll<HTMLElement>('.outline-child')).map((row) => [
        row.querySelector('.outline-name')?.textContent ?? null,
        row.querySelector('.outline-lock')?.textContent ?? null,
        row.querySelector('[data-testid="outline-group-state"]')?.textContent ?? null,
        row.querySelector('.outline-badge')?.textContent ?? null,
        row.querySelector('[data-testid="outline-group-score"]')?.textContent ?? null
    ]);
}

/** One group's row, found by its title span so an attention mark cannot confuse it with another row. */
function groupRow(container: HTMLElement, title: string): HTMLElement {
    const row = Array.from(container.querySelectorAll<HTMLElement>('.outline-child')).find(
        (element) => element.querySelector('.outline-name')?.textContent === title
    );

    if (!row) throw new Error(`no rail row titled ${title}`);

    return row;
}

describe('StoryOutline — a locked group says so in its row (R1)', () => {
    it('marks the three locked rows with ONE word, and leaves the two open ones untouched', () => {
        const { container } = render(
            <StoryOutline
                view={fixtureView({ phrase: lockedGroups() })}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={() => undefined}
            />
        );

        // The whole rail, in composition order: the lock word is `null` exactly where the wire says the group is
        // open, and the badge/score columns are byte-identical to the unlocked rail this fixture is pinned on
        // elsewhere in the suite (`['Premise', null, '1', '84%']`, …). A lock that hid either number fails here.
        // U-25 — the phrase's Seed row leads the list and carries no lock, no state, no badge and no score: a Seed
        // is settled text by construction (P5), so a lock mark on it would say nothing the row does not already say.
        expect(rowsOfSummary(container)).toEqual([
            ['Seed', null, null, null, null],
            ['Premise', 'Locked', null, '1', '84%'],
            ['Promise', null, null, '2', '62%'],
            ['Theme', 'Locked', 'writer', '2', '71%'],
            ['Tone', 'Locked', null, '1', '58%'],
            ['Ending', null, 'to write', '1', null]
        ]);
    });

    it('keeps the row name readable — "Premise Locked …", never "PremiseLocked" (T5’s separator rule)', () => {
        const { container } = render(
            <StoryOutline
                view={fixtureView({ phrase: lockedGroups() })}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={() => undefined}
            />
        );

        // The name is composed from the row's text: the title, the lock word, then the badge's own label and the
        // score's. The unlocked fixture's name for the same row is
        // `'Premise 1 open Critical or Major finding open findings to answer Score 84%'`, so the ONLY difference
        // is the one word — which is the whole acceptance ("the user sees which sections are locked").
        expect(
            screen.getByRole('button', {
                name: 'Premise Locked 1 open Critical or Major finding open findings to answer Score 84%'
            })
        ).toBeTruthy();
        // An Editor's lock is legible as a lock in the name too; the WHO is on the tooltip, where the rail puts
        // every fact 320px cannot fit.
        expect(
            screen.getByRole('button', {
                name: 'Theme Locked writer 2 open Critical or Major findings open findings to answer Score 71%'
            })
        ).toBeTruthy();
        // And the two open rows keep the names the suite already pins, with no stray word.
        expect(
            screen.getByRole('button', {
                name: 'Promise 2 open Critical or Major findings open findings to answer Score 62%'
            })
        ).toBeTruthy();
    });

    it('carries WHICH revision and WHO settled it on the row’s tooltip, in the pane’s own words (R1)', () => {
        const { container } = render(
            <StoryOutline
                view={fixtureView({ phrase: lockedGroups() })}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={() => undefined}
            />
        );

        // The tooltip is COMPOSED from every reason the row has, and the lock segment sits after the attention
        // label and before the engine state line — a group row has no state string, so the pair is the sentence.
        expect(groupRow(container, 'Premise').getAttribute('title')).toBe(
            'open findings to answer · Locked in at Revision 3 by author: this group\'s text is settled content — ' +
                'it cannot be revised from its pane, and the other groups adapt to it (R1).'
        );
        // An Editor's lock says EDITOR, which is the fact the Author audits the R2 Setting against, and the
        // revision is the group's own — Revision 1, the only one Theme ever wrote.
        expect(groupRow(container, 'Theme').getAttribute('title')).toBe(
            'open findings to answer · Locked in at Revision 1 by editor: this group\'s text is settled content — ' +
                'it cannot be revised from its pane, and the other groups adapt to it (R1).'
        );
        // A row whose lock names no actor says `by crew`: the pane's badge follows the same rule
        // (`story-contract.groupLockActorLabel`), so rail and pane never disagree about who.
        expect(groupRow(container, 'Tone').getAttribute('title')).toBe(
            'open findings to answer · Locked in at Revision 1 by crew: this group\'s text is settled content — ' +
                'it cannot be revised from its pane, and the other groups adapt to it (R1).'
        );
        // An open row's tooltip is exactly what it was before the lock shipped: no lock segment, no trailing
        // separator, and the attention label alone.
        expect(groupRow(container, 'Promise').getAttribute('title')).toBe('open findings to answer');
    });

    it('puts the word AFTER the title and BEFORE the counts, so the facts keep their order', () => {
        const { container } = render(
            <StoryOutline
                view={fixtureView({ phrase: lockedGroups() })}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={() => undefined}
            />
        );

        const row = groupRow(container, 'Premise');

        // Reading order, read off the DOM: the title, the lock word, then the badge, then the score. The score
        // stays LAST because the eye compares the numbers down the column; the lock stays FIRST because "is this
        // text settled?" is the question the rail answers before any count.
        const selector = '.outline-name, .outline-lock, .outline-badge, [data-testid="outline-group-score"]';
        const marks = Array.from(row.querySelectorAll<HTMLElement>(selector)).map((element) => element.className);

        expect(marks).toEqual(['outline-name', 'outline-lock', 'outline-badge', 'outline-score']);
        // The mark carries no `title` of its own: a nested tooltip would beat the row's composed one, and the
        // row's `title` is where the pane's two extra facts live.
        expect(row.querySelector('.outline-lock')?.hasAttribute('title')).toBe(false);
        // It is a word, not a glyph, so it survives greyscale and a screen reader (the discarded row's rule).
        expect(row.querySelector('.outline-lock')?.textContent).toBe('Locked');
        expect(row.querySelector('.outline-lock')?.getAttribute('data-testid')).toBe('outline-group-lock');
    });
});
