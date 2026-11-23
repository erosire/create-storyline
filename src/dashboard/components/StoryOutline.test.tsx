// The left rail after the redesign: four phrases, their entries, and the supporting folders.
//
// The rail must say exactly that and nothing else: the old knowledge header's subtitle, note
// count and "one article per folder" sentence are the clutter the redesign removed, and the
// Summary's tick is the only status it paints. A phrase HEADER is also its disclosure control (R8):
// clicking it folds that phrase's rows away and clicking it again unfolds them, without touching the
// other phrases or the selection.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StoryOutline } from './StoryOutline';
import { DEFAULT_STORY_SELECTION } from './story-nav';
import type { StorySelection } from './story-nav';
import { fixtureStory, fixtureSummary, fixtureView } from './story-fixtures';
import type { Cost, Finding, FindingState } from '../../shared/types';

/**
 * One settled Summary round for the discard tests (T4/R1 + R2): Revision 1 parked WITH a recorded reason,
 * Revision 2 parked as a LEGACY row (the field did not exist yet, so no reason at all), and Revision 3 the
 * draft the round kept. No findings and no verdicts: the rows then carry no badges, so each row's accessible
 * name is exactly its label plus the marker, and a test can pin that name without guessing.
 */
function discardRound() {
    return {
        ...fixtureView(),
        revisions: [
            {
                id: 'rv-disc-1',
                rev: 1,
                created_at: '2026-11-11T11:50:00.000Z',
                updated_at: '2026-11-11T11:56:00.000Z',
                story_id: 's1',
                unit_kind: 'summary' as const,
                unit_ref: 'sum1',
                body: { fields: { premise: 'the bell stays under the water' } },
                run_ref: 'run_writer_1',
                template_ref: 't-builtin',
                state: 'discarded' as const,
                verdict_refs: [],
                discard_reason: 'the kept draft states the change on the page sooner'
            },
            {
                id: 'rv-disc-2',
                rev: 1,
                created_at: '2026-11-11T11:51:00.000Z',
                updated_at: '2026-11-11T11:56:00.000Z',
                story_id: 's1',
                unit_kind: 'summary' as const,
                unit_ref: 'sum1',
                body: { fields: { premise: 'the archive hums when she lies' } },
                run_ref: 'run_writer_2',
                template_ref: 't-builtin',
                state: 'discarded' as const,
                verdict_refs: []
            },
            {
                id: 'rv-keep-3',
                rev: 1,
                created_at: '2026-11-11T11:52:00.000Z',
                updated_at: '2026-11-11T11:56:00.000Z',
                story_id: 's1',
                unit_kind: 'summary' as const,
                unit_ref: 'sum1',
                body: { fields: { premise: 'a flooded city keeps its memory under glass' } },
                run_ref: 'run_writer_3',
                template_ref: 't-builtin',
                state: 'selected' as const,
                verdict_refs: [],
                selection_note: 'it names its price in the first paragraph (L-17)'
            }
        ],
        findings: [],
        verdicts: []
    };
}

describe('StoryOutline — the phrase rail (U-4 / the phrase redesign)', () => {
    it('lists the four phrases and the supporting folders, with no knowledge copy', () => {
        render(<StoryOutline view={fixtureView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />);

        expect(screen.getByText('Phrase 1')).toBeTruthy();
        expect(screen.getByText('Phrase 2')).toBeTruthy();
        expect(screen.getByText('Phrase 3')).toBeTruthy();
        expect(screen.getByText('Phrase 4')).toBeTruthy();

        for (const heading of ['Summary', 'Characters', 'Plotlines', 'Chapters']) {
            expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
        }

        for (const folder of ['Continuity', 'Goal', 'Ideas', 'Findings', 'Digest', 'Settings']) {
            expect(screen.getAllByText(folder).length).toBeGreaterThan(0);
        }

        // The removed clutter: a harness-memory subtitle, a note count and the per-folder sentence.
        expect(screen.queryByText(/its own harness memory/)).toBeNull();
        expect(screen.queryByText(/notes$/)).toBeNull();
        expect(screen.queryByText(/one article per folder/)).toBeNull();
        expect(screen.queryByText(/written by this story/)).toBeNull();
    });

    it('marks the Summary ready for review with a tick and keeps a signed Summary ticked', () => {
        const signed = render(
            <StoryOutline view={fixtureView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        expect(signed.container.querySelector('.outline-ready')?.getAttribute('title')).toBe('ready for review');
        signed.unmount();

        const view = fixtureView();
        const ready = {
            ...view,
            story: { ...fixtureStory(), phase: 'summary' as const, summary_locked: false },
            summary: fixtureSummary(),
            // The tick waits for the round to have a winner; the fixture's competing draft is
            // parked as discarded so this row represents a finished round.
            revisions: view.revisions.map((revision) =>
                revision.unit_kind === 'summary' ? { ...revision, state: 'selected' as const } : revision
            ),
            goal: { ...view.goal, failing: [] }
        };
        const { container } = render(
            <StoryOutline view={ready} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );
        expect(container.querySelector('.outline-ready')).toBeTruthy();

        const notReady = {
            ...ready,
            summary: {
                ...fixtureSummary(),
                premise: undefined,
                promise: undefined,
                theme: undefined,
                tone: undefined,
                ending: undefined,
                world_rules: undefined
            }
        };
        const second = render(
            <StoryOutline view={notReady} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );
        const ticks = second.container.querySelectorAll('.outline-ready');
        expect(ticks.length).toBe(0);
    });

    it('highlights the rail entries that need the Author, without printing the report (U-1c)', () => {
        const view = fixtureView();
        const { container } = render(
            <StoryOutline view={view} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        // The fixture waits on an Idea pick and has competing Summary drafts.
        const ideas = Array.from(container.querySelectorAll<HTMLElement>('.outline-item')).find((element) =>
            element.textContent?.includes('Ideas')
        )!;
        const summary = Array.from(container.querySelectorAll<HTMLElement>('.outline-item--phrase')).find((element) =>
            element.textContent?.includes('Summary')
        )!;

        expect(ideas.getAttribute('data-attention')).toBe('awaiting');
        expect(ideas.getAttribute('title')).toContain('Idea');
        expect(summary.getAttribute('data-attention')).toBe('awaiting');
        expect(summary.getAttribute('title')).toBe('choose a draft');

        // The reason is a dot and a tooltip, not a paragraph of detail on the rail.
        expect(ideas.querySelector('.outline-attention')).toBeTruthy();
        expect(ideas.textContent).not.toContain('Reader proposed');
    });

    it('opens the phrase or the exact entry the Author clicked', () => {
        const selections: StorySelection[] = [];
        const { getByText, container } = render(
            <StoryOutline
                view={fixtureView()}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={(selection) => selections.push(selection)}
            />
        );

        fireEvent.click(getByText('Revision 1'));
        fireEvent.click(getByText('Hale'));
        fireEvent.click(getByText('Plotline 2 — Ghost Index'));
        fireEvent.click(getByText('Chapter 3 — The Water Line'));
        const findingsFolder = Array.from(container.querySelectorAll<HTMLElement>('.outline-item--folder')).find(
            (element) => element.textContent?.includes('Findings')
        )!;
        fireEvent.click(findingsFolder);

        expect(selections).toEqual([
            { panel: 'summary', ref: 'revision:rv-sum-a' },
            { panel: 'characters', ref: 'cast_member_1' },
            { panel: 'plotlines', ref: 'p2' },
            { panel: 'chapters', ref: 'c3' },
            { panel: 'findings' }
        ]);
    });

    it('files each Writer round as a flat Revision 1…N entry with its outstanding-findings badge', () => {
        const view = fixtureView();
        const rounds = ['rv-extra-1', 'rv-extra-2', 'rv-extra-3', 'rv-extra-4', 'rv-extra-5'].map(
            (id, index) => ({
                id,
                rev: 1,
                created_at: `2026-11-11T11:5${index}:00.000Z`,
                updated_at: `2026-11-11T11:5${index}:00.000Z`,
                story_id: 's1',
                unit_kind: 'summary' as const,
                unit_ref: 'sum1',
                body: { fields: { premise: `revision ${index + 1}` } },
                run_ref: `run_writer_${index + 1}`,
                template_ref: 't-builtin',
                state:
                    index === 0
                        ? ('selected' as const)
                        : index === 1
                          ? ('discarded' as const)
                          : ('competing' as const),
                verdict_refs: []
            })
        );
        const sampleView = { ...view, revisions: rounds };

        const selections: StorySelection[] = [];
        const { container } = render(
            <StoryOutline view={sampleView} selection={DEFAULT_STORY_SELECTION} onSelect={(next) => selections.push(next)} />
        );

        const summary = Array.from(container.querySelectorAll<HTMLElement>('.outline-phase')).find((element) =>
            element.textContent?.includes('Summary')
        )!;

        for (const label of ['Revision 1', 'Revision 2', 'Revision 3', 'Revision 4', 'Revision 5']) {
            expect(summary.textContent).toContain(label);
        }
        // No Overview tree and no nested Findings/Revisions list: each revision is a leaf.
        expect(summary.querySelectorAll('.outline-grandchildren').length).toBe(0);

        fireEvent.click(screen.getByText('Revision 3'));
        expect(selections).toContainEqual({ panel: 'summary', ref: 'revision:rv-extra-3' });
    });

    it('badges a Revision with its OPEN Critical/Major findings, and never with a Minor one', () => {
        const view = fixtureView();
        const revisionId = view.revisions.find((revision) => revision.unit_kind === 'summary')!.id;
        const finding = (id: string, cost: Cost, state: FindingState): Finding => ({
            id,
            rev: 1,
            created_at: '2026-11-11T10:00:00.000Z',
            updated_at: '2026-11-11T10:00:00.000Z',
            story_id: 's1',
            target_ref: 'sum1',
            criterion_ref: 'C-8',
            title: id,
            evidence: 'ch. 1, ¶1 — one unbroken block.',
            cost,
            fingerprint: `fp-${id}`,
            state,
            seen_count: 1,
            related_refs: [revisionId]
        });

        const open = [finding('f-crit', 'critical', 'approved'), finding('f-major', 'major', 'confirmed')];
        const closed = [finding('f-minor', 'minor', 'unconfirmed'), finding('f-fixed', 'critical', 'fixed')];
        const { container } = render(
            <StoryOutline
                view={{ ...view, findings: [...open, ...closed] }}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={() => undefined}
            />
        );

        const row = screen.getByText('Revision 1').closest('button')!;
        // The badge counts only the two costs that force the Author's hand: Critical and Major, and
        // only while they are open. Minor is filed, not raised; a fixed finding is not news.
        const badge = row.querySelector<HTMLElement>('.outline-badge')!;
        expect(badge.textContent).toBe('2');
        expect(badge.getAttribute('title')).toBe('2 open Critical or Major findings');
        // A leaf has nothing to expand, so no chevron sits in front of it.
        expect(row.querySelector('svg')).toBeNull();
        expect(container.querySelectorAll('.outline-chevron')).toHaveLength(0);
    });

    it('paints no badge when the only finding is Minor', () => {
        const view = fixtureView();
        const revisionId = view.revisions.find((revision) => revision.unit_kind === 'summary')!.id;
        const minor: Finding = {
            id: 'f-minor',
            rev: 1,
            created_at: '2026-11-11T10:00:00.000Z',
            updated_at: '2026-11-11T10:00:00.000Z',
            story_id: 's1',
            target_ref: 'sum1',
            criterion_ref: 'C-8',
            title: 'line edit',
            evidence: 'ch. 1, ¶1.',
            cost: 'minor',
            fingerprint: 'fp-minor',
            state: 'unconfirmed',
            seen_count: 1,
            related_refs: [revisionId]
        };

        render(
            <StoryOutline
                view={{ ...view, findings: [minor] }}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={() => undefined}
            />
        );

        const row = screen.getByText('Revision 1').closest('button')!;
        expect(row.querySelector('.outline-badge')).toBeNull();
    });

    it('keeps an empty Characters phrase clickable and childless', () => {
        const view = { ...fixtureView(), cast: [] };
        const { container } = render(
            <StoryOutline view={view} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        const phrase = Array.from(container.querySelectorAll<HTMLElement>('.outline-phase')).find((element) =>
            element.textContent?.includes('Characters')
        )!;
        expect(phrase.querySelectorAll('.outline-child').length).toBe(0);
        expect(phrase.querySelector<HTMLButtonElement>('.outline-item--phrase')?.disabled).toBe(false);
        expect(phrase.querySelector('.outline-start')).toBeTruthy();
    });

    // -----------------------------------------------------------------------
    // T4/R2, then R6 — the sidebar says WHICH revision a round discarded, at a glance.
    //
    // The original report was that Revision 1…N read alike, so a draft parked as history was invisible unless
    // the Author opened each one. The first fix was a `DISCARDED` pill; R6 is that the word is the part that
    // slows the eye down, so the visible mark is now the STRUCK-THROUGH name (`app.css` keys it on the row's
    // `data-state`, which jsdom does not apply — the pins below are therefore the DOM contract the stylesheet
    // reads). The word survives as an `sr-only` span, so a reader still says "Revision 1 Discarded" without an
    // `aria-label` that would replace the name and swallow the badge's and attention mark's own labels. The
    // row stays a button, because it is also the only way to open that draft and read its reason (R1).
    // -----------------------------------------------------------------------
    it('strikes the discarded Revision in its row and keeps the word for a reader, unmarked on the kept draft (T4/R2, R6)', () => {
        const { container } = render(
            <StoryOutline view={discardRound()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        // The accessible name is exactly what it was with the pill: one marker per discarded row, and no row
        // is marked twice.
        expect(screen.getByRole('button', { name: 'Revision 1 Discarded' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Revision 2 Discarded' })).toBeTruthy();

        const discarded = screen.getByRole('button', { name: 'Revision 1 Discarded' });
        // R6: the word exists ONCE, in the screen-reader span. The old visible pill is gone — no element, and
        // no leftover copy — and the row's visible label is the revision name and nothing else.
        expect(discarded.querySelectorAll('.sr-only')).toHaveLength(1);
        expect(discarded.querySelector('.sr-only')?.textContent).toBe('Discarded');
        expect(container.querySelectorAll('.outline-discarded')).toHaveLength(0);
        expect(discarded.querySelector('.outline-name')?.textContent).toBe('Revision 1');
        // The separation pinned at the DOM level as well: the failure pinned at T5 was the accessibility tree
        // flattening the row into "Revision 1Discarded". An accessible name is computed from text, so the
        // row-level text node carries the space — no `gap`, `padding` or `display` rule is involved.
        expect(discarded.textContent).toBe('Revision 1 Discarded');
        // A leaf row carries no icon, and the state is not smuggled out of the accessible name either: no
        // second marker, and no `title` on the span that would beat the row's own composed tooltip.
        expect(discarded.querySelector('svg')).toBeNull();
        expect(discarded.querySelector('.sr-only')?.hasAttribute('title')).toBe(false);
        // What the stylesheet keys the strike on: the engine's word, on the row, never on a copy of it.
        expect(discarded.getAttribute('data-state')).toBe('discarded');

        // The draft the round KEPT keeps reading as a plain row — the mark is a state, not decoration.
        const kept = screen.getByRole('button', { name: 'Revision 3' });

        expect(kept.querySelector('.sr-only')).toBeNull();
        expect(kept.querySelector('.outline-name')?.textContent).toBe('Revision 3');
        expect(kept.getAttribute('data-state')).toBe('selected');
    });

    it('still opens a discarded revision from its marked row (T4/R2)', () => {
        const selections: StorySelection[] = [];
        render(
            <StoryOutline
                view={discardRound()}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={(next) => selections.push(next)}
            />
        );

        fireEvent.click(screen.getByText('Revision 1'));
        fireEvent.click(screen.getByText('Revision 2'));

        expect(selections).toEqual([
            { panel: 'summary', ref: 'revision:rv-disc-1' },
            { panel: 'summary', ref: 'revision:rv-disc-2' }
        ]);
    });

    it('names the recorded reason in the row tooltip, beside the state — never instead of it (T4/R1)', () => {
        const { container } = render(
            <StoryOutline view={discardRound()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        // Every reason the row owns is COMPOSED into one tooltip. The row's own state segment is kept
        // even though a reason exists: an explanation must not replace the fact it explains, and the same
        // composition is what keeps an attention label from hiding the state (the old `??` chain let one
        // label swallow the other). R6 removed the visible word, and this is why the reason is still
        // discoverable: it rides on the row the strike-through points at.
        const discarded = screen.getByRole('button', { name: 'Revision 1 Discarded' });

        expect(discarded.getAttribute('title')).toBe(
            'Revision 1 · discarded · Discard reason: the kept draft states the change on the page sooner'
        );

        // A row with no reason to show keeps the plain state tooltip it always had, and a row that was
        // not discarded is untouched.
        expect(container.querySelectorAll('.outline-child[data-state="discarded"]')).toHaveLength(2);
        expect(screen.getByRole('button', { name: 'Revision 2 Discarded' }).getAttribute('title')).toBe(
            'Revision 2 · discarded'
        );
        expect(screen.getByRole('button', { name: 'Revision 3' }).getAttribute('title')).toBe(
            'Revision 3 · selected'
        );
    });

    it('marks a legacy discard that has no reason, and invents none (T4/R1)', () => {
        render(
            <StoryOutline view={discardRound()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        // Revision 2 is `discarded` with no `discard_reason` at all (a row from before the field landed).
        // It is still marked — the marker cannot depend on the reason existing…
        const legacy = screen.getByRole('button', { name: 'Revision 2 Discarded' });

        expect(legacy.querySelector('.sr-only')?.textContent).toBe('Discarded');
        expect(legacy.getAttribute('data-state')).toBe('discarded');
        // Its name separates the two words too — the marker never depends on the reason existing.
        expect(legacy.textContent).toBe('Revision 2 Discarded');
        // …and it says nothing beyond the state, because a reason the server never wrote is not the
        // dashboard's to make up. The trailing check is the failure mode, not a style rule: an unwritten
        // field must not reach the rail as the word "undefined".
        expect(legacy.getAttribute('title')).toBe('Revision 2 · discarded');
        expect(document.body.textContent).not.toContain('Discard reason: undefined');
    });
});

// ---------------------------------------------------------------------------
// R6 — "don't need to say DISCARDED, just cross out the word for easier view".
//
// The DOM case above proves the word still exists for a reader and nowhere else. What it cannot prove is the
// half that is VISIBLE: jsdom never applies `app.css`, so neither the strike nor the pill's absence can be
// read off the rendered tree. The stylesheet is therefore read as source for this one case (the repo already
// pins source-level contracts this way — `dashboard/server-boundary.test.ts`, `server/criteria/engine.test.ts`):
// the strike keys on the row's own `data-state` and paints the revision NAME, and the pill rule is gone so a
// `DISCARDED` label cannot creep back into the rail.
// ---------------------------------------------------------------------------
describe('StoryOutline — the discarded mark is the struck name (R6)', () => {
    it('paints the strike on `.outline-name` from the row state, and carries no DISCARDED pill rule', () => {
        // Comments are stripped first: the assertion is about the rules that reach the browser, not about a
        // comment that happens to name a class.
        const css = readFileSync(`${import.meta.dirname}/../styles/app.css`, 'utf8');
        const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

        // The pill is gone from the stylesheet: no rule, so no visible label anywhere in the rail.
        expect(rules).not.toContain('.outline-discarded');
        // The strike exists, is keyed on the ENGINE's word for the row (never a copy of it), and paints the
        // row's NAME — the revision itself reads as crossed out. Exact declarations, whitespace-collapsed.
        const struck = rules.match(/\.outline-child\[data-state='discarded'\][^{]*\{([^}]*)\}/);

        expect(struck === null ? struck : (struck[1] ?? '').replace(/\s+/g, ' ').trim()).toBe(
            'color: var(--halt); text-decoration: line-through;'
        );
    });
});

// ---------------------------------------------------------------------------
// R8 — "this should be collapsible: clicking `Phrase 1` collapses it".
//
// The rail is four phrases plus a Revision 1…N list under each, and the list is the part that crowds it. The
// whole header is the toggle — the rail has never carried a chevron of its own, and a second control would be
// chrome rather than a fix — and the second click expands. Everything else about the rail has to survive the
// fold: the phrase stays selected, every other phrase keeps its own state, and a collapsed phrase's rows are
// UNMOUNTED (so they leave the tab order) rather than deleted — re-expanding restores the same rows, markers,
// badges and tooltips in the same order, because parked history is not the rail's to throw away.
// ---------------------------------------------------------------------------
describe('StoryOutline — the phrase header is a disclosure control (R8)', () => {
    /** One phrase's header button, found by its own title span so an attention mark cannot confuse it. */
    function phraseHeader(container: HTMLElement, title: string): HTMLButtonElement {
        const header = Array.from(container.querySelectorAll<HTMLButtonElement>('.outline-item--phrase')).find(
            (element) => element.querySelector('.outline-name')?.textContent === title
        );

        if (!header) throw new Error(`no phrase header titled ${title}`);

        return header;
    }

    /** A phrase group's rows as (label, state) pairs — the whole list, so a reshuffle fails the test. */
    function rowsOf(group: Element): Array<Array<string | undefined>> {
        return Array.from(group.querySelectorAll<HTMLElement>('.outline-child')).map((row) => [
            row.querySelector('.outline-name')?.textContent,
            row.dataset.state
        ]);
    }

    it('collapses and re-expands Phrase 1 on the whole header, and still navigates on every click', () => {
        const selections: StorySelection[] = [];
        const { container } = render(
            <StoryOutline
                view={discardRound()}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={(next) => selections.push(next)}
            />
        );

        const summary = phraseHeader(container, 'Summary');
        const group = summary.closest('.outline-phase')!;

        // Default EXPANDED: the rail the suite has always seen, and the header points at the list it governs —
        // `aria-controls` is only carried while that list is actually in the DOM, so the IDREF never dangles.
        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(summary.getAttribute('aria-controls')).toBe('outline-children-summary');
        expect(container.querySelector('#outline-children-summary')?.id).toBe('outline-children-summary');
        expect(rowsOf(group)).toEqual([
            ['Revision 1', 'discarded'],
            ['Revision 2', 'discarded'],
            ['Revision 3', 'selected']
        ]);

        // One click folds it: the rows are GONE from the DOM, which is what takes them out of the tab order.
        fireEvent.click(summary);

        expect(summary.getAttribute('aria-expanded')).toBe('false');
        // The controlled list went with the rows, so the header names NO id rather than a removed one:
        // `aria-controls` is optional on a disclosure button, and a dangling IDREF is worse than none.
        expect(summary.hasAttribute('aria-controls')).toBe(false);
        expect(container.querySelector('#outline-children-summary')).toBeNull();
        expect(rowsOf(group)).toEqual([]);
        expect(screen.queryByText('Revision 1')).toBeNull();
        // The click navigated as well, even though Phrase 1 was ALREADY the selection — the shell reads every
        // rail click as navigation and clears the selected-agent thread view, so a toggle-only header (or an
        // early return for the selected phrase) would strand the content area on a child of a folded phrase.
        expect(selections).toEqual([{ panel: 'summary' }]);
        // Folding is not un-selecting: `aria-current` is a separate state.
        expect(summary.getAttribute('aria-current')).toBe('page');

        // The second click expands, and NOTHING about the history changed while it was hidden: same rows, same
        // order, same strikes, same tooltip — including the recorded discard reason (T4/R1).
        fireEvent.click(summary);

        expect(summary.getAttribute('aria-expanded')).toBe('true');
        // `aria-controls` comes back WITH the list, and resolves to it again.
        expect(summary.getAttribute('aria-controls')).toBe('outline-children-summary');
        expect(container.querySelector('#outline-children-summary')?.id).toBe('outline-children-summary');
        // The IDREF names the list that HOLDS the rows, not some other element with that id.
        expect(container.querySelector('#outline-children-summary')?.querySelectorAll('.outline-child')).toHaveLength(
            3
        );
        expect(rowsOf(group)).toEqual([
            ['Revision 1', 'discarded'],
            ['Revision 2', 'discarded'],
            ['Revision 3', 'selected']
        ]);
        expect(group.querySelectorAll<HTMLElement>('.outline-child')[0]?.getAttribute('title')).toBe(
            'Revision 1 · discarded · Discard reason: the kept draft states the change on the page sooner'
        );
        expect(screen.getByRole('button', { name: 'Revision 1 Discarded' })).toBeTruthy();
        // The expanded click navigated too, so the shell never loses a rail click to the fold.
        expect(selections).toEqual([{ panel: 'summary' }, { panel: 'summary' }]);
    });

    it('folds one phrase without touching the others, and keeps each phrase’s own state', () => {
        const { container } = render(
            <StoryOutline view={fixtureView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        const summary = phraseHeader(container, 'Summary');
        const characters = phraseHeader(container, 'Characters');

        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(characters.getAttribute('aria-expanded')).toBe('true');

        fireEvent.click(summary);

        expect(summary.getAttribute('aria-expanded')).toBe('false');
        expect(characters.getAttribute('aria-expanded')).toBe('true');
        // Folded Summary carries no IDREF at all, while open Characters still points at its own list: the two
        // states are per phrase, and an IDREF is only ever carried by the header whose list exists.
        expect(summary.hasAttribute('aria-controls')).toBe(false);
        expect(characters.getAttribute('aria-controls')).toBe('outline-children-characters');
        expect(container.querySelector('#outline-children-summary')).toBeNull();
        expect(container.querySelector('#outline-children-characters')).toBeTruthy();

        // Folding Characters leaves Summary folded: the state is per phrase, never one switch for the rail.
        fireEvent.click(characters);

        expect(characters.getAttribute('aria-expanded')).toBe('false');
        expect(summary.getAttribute('aria-expanded')).toBe('false');
        expect(characters.hasAttribute('aria-controls')).toBe(false);
        expect(container.querySelector('#outline-children-characters')).toBeNull();

        // And each phrase opens on its own.
        fireEvent.click(summary);

        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(summary.getAttribute('aria-controls')).toBe('outline-children-summary');
        expect(characters.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('#outline-children-summary')).toBeTruthy();
        expect(container.querySelector('#outline-children-characters')).toBeNull();
    });

    it('leaves a childless phrase a plain row, and a row with a ref still opens on click', () => {
        const selections: StorySelection[] = [];
        const { container } = render(
            <StoryOutline
                view={{ ...fixtureView(), cast: [] }}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={(next) => selections.push(next)}
            />
        );

        const characters = phraseHeader(container, 'Characters');

        // Nothing to disclose: with no children the list is not rendered, so the header carries NO `aria-controls`
        // (naming an id that never exists would be a dangling IDREF) while `aria-expanded` stays present and
        // current — it is still a disclosure row, there is simply nothing in it. The row is still navigation,
        // still enabled, with the "can be started" affordance it had before R8.
        expect(characters.getAttribute('aria-expanded')).toBe('true');
        expect(characters.hasAttribute('aria-controls')).toBe(false);
        expect(container.querySelector('#outline-children-characters')).toBeNull();
        expect(characters.disabled).toBe(false);
        expect(characters.querySelector('.outline-start')).toBeTruthy();

        fireEvent.click(characters);

        expect(selections).toEqual([{ panel: 'characters' }]);

        // A row inside another phrase is unaffected by Summary being folded, and still opens its entry.
        fireEvent.click(phraseHeader(container, 'Summary'));
        fireEvent.click(screen.getByText('Chapter 3 — The Water Line'));

        expect(selections).toEqual([{ panel: 'characters' }, { panel: 'summary' }, { panel: 'chapters', ref: 'c3' }]);
    });
});
