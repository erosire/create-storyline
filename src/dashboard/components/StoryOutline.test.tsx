// The left rail after the redesign: four phrases, their entries, and the supporting folders.
//
// The rail must say exactly that and nothing else: the old knowledge header's subtitle, note
// count and "one article per folder" sentence are the clutter the redesign removed, and the
// Summary's tick is the only status it paints. A phrase HEADER is also its disclosure control (U-21):
// clicking it folds that phrase's rows away and clicking it again unfolds them, without touching the
// other phrases or the selection.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StoryOutline } from './StoryOutline';
import { DEFAULT_STORY_SELECTION, phraseSeedRef } from './story-nav';
import type { StorySelection } from './story-nav';
import { fixturePhrase, fixtureStory, fixtureSummary, fixtureView } from './story-fixtures';
// R-T2/F1 + F2: the rail's ready tick and its phrase-read line are driven by the same frame the gate reads,
// so the regression is pinned on the real rail — the five clean rows coming from the wire-shaped projection.
import { groupedPhraseView, phraseDetailView } from '../testing/shell-fakes';
// T-W4 — the Phrase ② read the rail paints its marks and entry rows from, and the view type the fixture
// builder has to return so a wrong field name fails at compile time rather than as an empty rail.
import type { PhraseDetailView } from '../api';
import type { StoryViewData } from './story-contract';
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
    // R6 / U1 + T-W4 — the rail is the desk's table of contents, and a desk opens a PHRASE pane, one of its
    // entries, a supplementary sheet, or a folder. T-W4 moves Plotlines onto the rail as Phrase ②, so the rail
    // carries TWO phrase rows, and Characters leaves the numbered rail for the Supplements section. Every row must
    // be a pane the content column can open — that is the defect the acceptance names ("no nav to hidden
    // phrases") — so the phrase count and the phrase names below are the assertion: an extra header would be an
    // unreachable row, and a wrong name would be a rail pointing at the wrong pane.
    it('lists the Summary phrase and the supporting folders, and nothing the content column cannot open (U1)', () => {
        const { container } = render(
            <StoryOutline view={fixtureView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        expect(screen.getByText('Phrase 1')).toBeTruthy();
        expect(screen.getByText('Phrase 2')).toBeTruthy();
        expect(screen.getAllByText('Summary').length).toBeGreaterThan(0);

        // Plotlines is a rail row and Characters — which left the numbered rail — is a row of the Supplements
        // section, still one click and still the same `{panel:'characters'}` selection. Chapters is not on the rail
        // at all: it was not before this phase either (the rail reaches it from a pane's own link), and T-W4 does
        // not change that.
        for (const shown of ['Plotlines', 'Characters']) {
            expect(screen.getAllByText(shown).length).toBeGreaterThan(0);
        }

        expect(screen.queryByText('Chapters')).toBeNull();

        const charactersRow = screen.getByRole('button', { name: 'Characters' });

        expect(charactersRow.closest('[data-testid="outline-supplements"]')).not.toBeNull();
        // Phrase ② is Plotlines, not Characters: the numbered rail's second row is the one the loop writes.
        expect(
            Array.from(document.querySelectorAll<HTMLElement>('.outline-item--phrase')).map(
                (row) => row.querySelector('.outline-name')?.textContent
            )
        ).toEqual(['Summary', 'Plotlines']);

        for (const folder of ['Continuity', 'Goal', 'Ideas', 'Findings', 'Digest', 'Settings']) {
            expect(screen.getAllByText(folder).length).toBeGreaterThan(0);
        }

        // U-25 — the Seed is a PHRASE CHILD now, one row under each phrase, and the row the rail used to pin above
        // `Phrases` is gone: no "The Author's idea" row, and exactly one `.outline-item--seed` per phrase list.
        const seedRows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="outline-seed"]'));

        expect(seedRows).toHaveLength(2);
        expect(
            seedRows.map((row) => row.querySelector('.outline-name')?.textContent)
        ).toEqual(['Seed', 'Seed']);
        expect(container.querySelector('#outline-children-summary [data-testid="outline-seed"]')).toBeTruthy();
        expect(container.querySelector('#outline-children-plotlines [data-testid="outline-seed"]')).toBeTruthy();
        // The old top-level row, and the sentence it printed, are nowhere in the rail.
        expect(screen.queryByText("The Author's idea")).toBeNull();
        expect(container.querySelector('.outline-group > .outline-item--seed')).toBeNull();

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
        expect(ideas.textContent).not.toContain('Critic proposed');
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

        // A sampling book's rows are its Revisions (U1 keeps that rail for books the group model never took
        // over), and the row's ref is the draft's own id — the address the pane and the override both use.
        fireEvent.click(getByText('Revision 1'));
        const findingsFolder = Array.from(container.querySelectorAll<HTMLElement>('.outline-item--folder')).find(
            (element) => element.textContent?.includes('Findings')
        )!;
        fireEvent.click(findingsFolder);

        expect(selections).toEqual([
            { panel: 'summary', ref: 'revision:rv-sum-a' },
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

    // R6 / U6 — the loading state of a phrase that IS group-managed. The Story row carries `summary_mode` (it
    // arrives on `GET /stories/:id`); the group rows arrive on the phrase route. Until they do, the rail must not
    // print five rows saying "unwritten": that is a claim about the book, and the honest statement is that the
    // rows are on their way. The header itself stays navigation — its pane (the Overview) exists immediately.
    it('keeps a childless phrase clickable, and says the group rows are on their way (U6)', () => {
        const grouped = { ...fixtureView(), story: { ...fixtureStory(), summary_mode: 'groups' as const } };
        const selections: StorySelection[] = [];
        const { container } = render(
            <StoryOutline view={grouped} selection={DEFAULT_STORY_SELECTION} onSelect={(next) => selections.push(next)} />
        );

        const phrase = Array.from(container.querySelectorAll<HTMLElement>('.outline-phase')).find((element) =>
            element.textContent?.includes('Summary')
        )!;

        // U-25 — exactly ONE child row while the groups are on their way: the phrase's Seed. It is not a row-shaped
        // claim about the five groups (it says nothing about what the loop has written), and it is the one child a
        // phrase always has. The group rows still arrive with the read, and nothing else appears before them.
        const rows = Array.from(phrase.querySelectorAll<HTMLElement>('.outline-child'));

        expect(rows).toHaveLength(1);
        expect(rows[0]?.getAttribute('data-testid')).toBe('outline-seed');
        expect(rows[0]?.querySelector('.outline-name')?.textContent).toBe('Seed');
        expect(phrase.querySelector('[data-testid="outline-phrase-pending"]')?.textContent).toBe(
            'reading the Summary groups…'
        );

        const header = phrase.querySelector<HTMLButtonElement>('.outline-item--phrase')!;

        expect(header.disabled).toBe(false);
        // U-25 — the IDREF IS carried here, where the old rail had none: the Seed row makes the list real, so the
        // header points at a list that is in the DOM. It is still the header's own click that opens the Overview.
        expect(header.getAttribute('aria-controls')).toBe('outline-children-summary');

        fireEvent.click(header);

        expect(selections).toEqual([{ panel: 'summary' }]);
    });

    // R-T2/F1 + F2 — THE RAIL'S OWN HALF of the sign-off gate. `summaryReadyForReview` counts GROUP ROWS, and
    // `phraseGroups` answers `[]` while the phrase read is in flight, so the rail used to tick "ready for
    // review" over a Summary it had never read — with Accept/Lock live under it, because the gate counts the
    // same rows. A FAILED read is the same absence with a different sentence, and the rail is where that
    // sentence has to appear: the top bar reports the Story payload's failures (L-13), not the phrase read's.
    it('withholds the ready tick until the group rows arrive, and says so when the read failed (F1, F2)', () => {
        const frame = (overrides: Record<string, unknown> = {}) => {
            const view = fixtureView({ phrase: groupedPhraseView('s1') });

            return {
                ...view,
                ...overrides,
                story: {
                    ...fixtureStory(),
                    summary_mode: 'groups' as const,
                    phase: 'summary' as const,
                    summary_locked: false
                },
                goal: { ...view.goal, failing: [] },
                ideas: []
            };
        };

        // The book WITH its rows: five group children and the tick, because the Overview is complete and
        // nothing is open. This is the frame the two below are measured against.
        const arrived = render(
            <StoryOutline view={frame()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        expect(arrived.container.querySelector('.outline-ready')?.getAttribute('title')).toBe('ready for review');
        arrived.unmount();

        // In flight: no tick, and the rail's one loading line — not a verdict about an empty Summary.
        const inFlight = render(
            <StoryOutline
                view={frame({ phrase: undefined })}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={() => undefined}
            />
        );

        expect(inFlight.container.querySelector('.outline-ready')).toBeNull();
        expect(inFlight.container.querySelector('[data-testid="outline-phrase-pending"]')?.textContent).toBe(
            'reading the Summary groups…'
        );
        expect(inFlight.container.querySelector('[data-testid="outline-phrase-error"]')).toBeNull();
        inFlight.unmount();

        // Failed: the loading line is gone, and the server's own sentence is in the rail with the warning
        // class the stylesheet keys. The Story's other rows are untouched (the failure is the read's).
        const failed = render(
            <StoryOutline
                view={frame({ phrase: undefined, phraseError: '503: the phrase read is offline (maintenance)' })}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={() => undefined}
            />
        );
        const line = failed.container.querySelector('[data-testid="outline-phrase-error"]');

        expect(failed.container.querySelector('.outline-ready')).toBeNull();
        expect(failed.container.querySelector('[data-testid="outline-phrase-pending"]')).toBeNull();
        expect(line?.textContent).toBe('Summary groups unread: 503: the phrase read is offline (maintenance)');
        // The class the stylesheet colours amber (`.outline-pending--error`), so the rail's failure reads as
        // one state without the colour carrying the meaning alone.
        expect(line?.classList.contains('outline-pending--error')).toBe(true);
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
// T3 — the rail's percentage has to behave as a COLUMN, not as a sentence.
//
// Nothing about the number is text-only: five digits in a 320px rail read top-to-bottom only if the value
// cannot stretch (a flexing score pushes the group's title into an ellipsis, which is the row's identity) and
// if its digits line up (proportional figures make `84%` and `100%` start at different x, and a column that
// jitters cannot be compared). jsdom never applies `app.css`, so the stylesheet is read as source here, the
// same way the strike test above proves what is visible. The badge's `margin-left: auto` is pinned too: it is
// the ONE right-aligning element in the row, and a second auto margin would split the free space and move the
// badge off the end of the column.
// ---------------------------------------------------------------------------
describe('StoryOutline — the score column is styled as a column (T3)', () => {
    /** One rule's declarations from `app.css`: comments stripped, whitespace collapsed to one line. */
    function cssRule(selector: string): string | null {
        const css = readFileSync(`${import.meta.dirname}/../styles/app.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const rule = css.match(
            new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)
        );

        return rule === null ? null : (rule[1] ?? '').replace(/\s+/g, ' ').trim();
    }

    it('holds the score at its natural width with tabular figures, and keeps the badge the only auto margin', () => {
        // `flex: none` is the load-bearing declaration; the rest is what makes five of them readable as a list.
        expect(cssRule('.outline-score')).toBe(
            'flex: none; min-width: 2.6em; text-align: right; color: var(--muted); font-size: 10px; ' +
                'font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap;'
        );
        expect(cssRule('.outline-score')).not.toContain('margin-left');
        // The header's average is the stronger of the two numbers on the rail, and it is the only one painted
        // with `--text-strong`: the rows stay recede-able so the eye finds the title column first.
        expect(cssRule('.outline-score--header')).toBe('color: var(--text-strong); font-size: 10.5px;');
        // …and the badge still owns the one auto margin in the row.
        expect(cssRule('.outline-badge')).toContain('margin-left: auto;');
    });
});

// ---------------------------------------------------------------------------
// U-21 — "this should be collapsible: clicking `Phrase 1` collapses it".
//
// The rail is four phrases plus a Revision 1…N list under each, and the list is the part that crowds it. The
// whole header is the toggle — the rail has never carried a chevron of its own, and a second control would be
// chrome rather than a fix — and the second click expands. Everything else about the rail has to survive the
// fold: the phrase stays selected, every other phrase keeps its own state, and a collapsed phrase's rows are
// UNMOUNTED (so they leave the tab order) rather than deleted — re-expanding restores the same rows, markers,
// badges and tooltips in the same order, because parked history is not the rail's to throw away.
// ---------------------------------------------------------------------------
describe('StoryOutline — the phrase header is a disclosure control (U-21)', () => {
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
        // U-25 — the phrase's Seed is its FIRST row, ahead of the parked drafts, and it takes none of their marks
        // (`data-state` is absent, so it never wears the struck-out `discarded` styling).
        expect(rowsOf(group)).toEqual([
            ['Seed', undefined],
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
        // U-25 + U-21 — the Seed row folds WITH the phrase: it lives inside the same `<ul>`, so a folded Phrase 1
        // has no Seed row in the DOM or the tab order either. It is unmounted, not deleted (the next click puts it
        // back, first, with the same marks).
        expect(group.querySelector('[data-testid="outline-seed"]')).toBeNull();
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
            4
        );
        // And the rows came back exactly as they were — the Seed first, then the parked drafts with their strikes
        // and their order untouched by the fold.
        expect(rowsOf(group)).toEqual([
            ['Seed', undefined],
            ['Revision 1', 'discarded'],
            ['Revision 2', 'discarded'],
            ['Revision 3', 'selected']
        ]);
        expect(group.querySelectorAll<HTMLElement>('.outline-child')[1]?.getAttribute('title')).toBe(
            'Revision 1 · discarded · Discard reason: the kept draft states the change on the page sooner'
        );
        expect(screen.getByRole('button', { name: 'Revision 1 Discarded' })).toBeTruthy();
        // The expanded click navigated too, so the shell never loses a rail click to the fold.
        expect(selections).toEqual([{ panel: 'summary' }, { panel: 'summary' }]);
    });

    // R6 retitles this test rather than weakening it, and U-25 restates the SEED half of its name: the rail no
    // longer pins a top-level Seed row, so the Seed a fold may not disturb is the OTHER phrase's. Folding Summary
    // removes that phrase's own rows — its Seed row included, because U-25 put the Seed INSIDE the fold — and it
    // leaves Phrase ②'s Seed, the supplements and the folders exactly where they were. T-W4 moves Characters into
    // a Supplements section that reuses the folder row's class, so the folder-class count below is seven (six
    // folders + Characters); what the fold may still not do is leak: it removes one phrase's rows and nothing else,
    // and it is not undone by navigating to a folder.
    it('folds the Summary phrase with its own Seed row and leaves the other phrase and the folders alone (U-25)', () => {
        const { container } = render(
            <StoryOutline view={fixtureView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        const summary = phraseHeader(container, 'Summary');

        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(summary.getAttribute('aria-controls')).toBe('outline-children-summary');

        const folderRows = () => Array.from(container.querySelectorAll<HTMLElement>('.outline-item--folder')).map(
            (element) => element.textContent
        );
        const foldersBefore = folderRows();

        // U-25 — every `.outline-item--seed` sits inside a phrase: which phrase owns each row is read off the DOM,
        // so an orphaned top-level Seed row would show up here as a `null` owner.
        const seedOwners = () =>
            Array.from(container.querySelectorAll<HTMLElement>('.outline-item--seed')).map(
                (element) => element.closest('li.outline-phase')?.querySelector('.outline-name')?.textContent ?? null
            );

        expect(container.querySelectorAll('.outline-item--folder')).toHaveLength(7);
        expect(seedOwners()).toEqual(['Summary', 'Plotlines']);

        fireEvent.click(summary);

        // The Summary's list is gone, and it took its rows with it — the Seed row of THAT phrase included, since it
        // lives in the folded `<ul>` (U-25 + U-21). Every row the rail still offers is untouched: same seven
        // folders, same order, same names, and Phrase ②'s Seed still in place.
        expect(summary.getAttribute('aria-expanded')).toBe('false');
        expect(summary.hasAttribute('aria-controls')).toBe(false);
        expect(container.querySelector('#outline-children-summary')).toBeNull();
        expect(folderRows()).toEqual(foldersBefore);
        expect(seedOwners()).toEqual(['Plotlines']);

        // Navigating to a folder does not unfold the phrase: the fold is the rail's own view state, and the
        // selection is a separate one (the same separation `aria-current` is pinned behind in the test above).
        // Which folder is irrelevant — the point is that ANY navigation leaves the fold alone.
        const aFolder = container.querySelectorAll<HTMLElement>('.outline-item--folder')[1]!;

        fireEvent.click(aFolder);

        expect(summary.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('#outline-children-summary')).toBeNull();

        // And the second click on the header brings the rows back.
        fireEvent.click(summary);

        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(summary.getAttribute('aria-controls')).toBe('outline-children-summary');
        expect(container.querySelector('#outline-children-summary')?.querySelectorAll('.outline-child').length)
            .toBeGreaterThan(0);
    });

    // R6 / U1 + U2 — a group row is the pane's address, and the address is the row's id, not its position. The
    // ref the rail emits is `summary-group:<id>`; the pane, the directive bar and the revise route all take that
    // same id, so a rail click and a group write cannot drift apart.
    it('opens the group a row addresses, and the header still drops the ref and opens the Overview', () => {
        const selections: StorySelection[] = [];
        const { container } = render(
            <StoryOutline
                view={fixtureView({ phrase: fixturePhrase() })}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={(next) => selections.push(next)}
            />
        );

        // The row's accessible name is its title, then the findings badge's own label (R6's rule for a row: the
        // name is composed from its text, never an `aria-label` that would swallow the badge). Premise is written
        // and holds nothing of its own, so the ONLY words after its title are the one blocking finding the
        // Reviewer never scoped to a group — which by R3 stands against every group of this book — and the score
        // the latest pass gave it (T3, `84%` of `[84, 78]`, newest first on the wire).
        fireEvent.click(
            screen.getByRole('button', {
                name: 'Premise 1 open Critical or Major finding open findings to answer Score 84%'
            })
        );

        expect(selections).toEqual([{ panel: 'summary', ref: 'summary-group:grp-premise' }]);

        // The header is the Overview: clicking it clears the row ref, exactly as it clears a revision ref, so a
        // folded-and-reopened phrase never strands the content column on a group the Author left.
        fireEvent.click(phraseHeader(container, 'Summary'));

        expect(selections).toEqual([
            { panel: 'summary', ref: 'summary-group:grp-premise' },
            { panel: 'summary' }
        ]);
    });
});

// ---------------------------------------------------------------------------
// T-W4 — PHRASE ② ON THE RAIL: Plotlines takes the second numbered slot, and the row carries the marks the
// Author needs to know the handoff's state without opening the pane: `outline-plotlines-start` (the compiled
// Summary is waiting to be copied), `outline-plotlines-state` (it has been). Both come from the story's own
// flags — `summary_compiled` and `phrase_started.plotlines` — never from a row count, because an unstarted
// phrase and a phrase whose read failed both have zero rows. The entry rows and the read lines come from the
// phrase read the shell caches (`state.ts:phraseDetails`), which the rail reaches through
// `story-contract.plotlinesSurfaceView`, and Characters now lives in the Supplements section.
// ---------------------------------------------------------------------------
describe('StoryOutline — the Plotlines phrase (T-W4)', () => {
    /**
     * The grouped book with Phrase ② in exactly the state the test asks for. `detail` is the phrase read:
     * a `PhraseDetailView` (it landed), `null` (it failed — the server's sentence goes in `phraseDetailError`,
     * which is what the rail prints) or absent (it was never fetched).
     */
    function phraseTwoView(
        over: {
            mode?: 'groups' | 'classic';
            started?: boolean;
            compiled?: boolean;
            detail?: PhraseDetailView | null;
        } = {}
    ): StoryViewData {
        const view = fixtureView({ phrase: fixturePhrase() });

        return {
            ...view,
            // The three T-W4 facts travel on the STORY VIEW (`api.ts:StoryView`, lines 319-347): the projection
            // echoes the dial and computes the compiled/started flags, so the panes read them here rather than
            // re-deriving them from rows (L-14). `story.plotlines_mode` is the same dial on the row the Settings
            // pane writes, and `isPlotlinesGroups` reads THAT before the read's `mode` — a frame with neither
            // answers classic, which is the honest default.
            plotlines_mode: over.mode ?? 'groups',
            phrase_started: { summary: true, plotlines: over.started === true },
            summary_compiled: over.compiled === true,
            story: { ...view.story, plotlines_mode: over.mode ?? 'groups' },
            ...(over.detail === null
                ? { phraseDetailError: 'the gateway is not answering' }
                : over.detail === undefined
                  ? {}
                  : { phraseDetail: over.detail })
        };
    }

    /** The rail's Phrase ② header row — the row that carries the marks, found by name, never by index. */
    function plotlinesRow(container: HTMLElement): HTMLButtonElement {
        return Array.from(container.querySelectorAll<HTMLButtonElement>('.outline-item--phrase')).find(
            (element) => element.querySelector('.outline-name')?.textContent === 'Plotlines'
        )!;
    }

    it('prompts the handoff on the row only while the compiled Summary has not been handed over', () => {
        const ready = render(
            <StoryOutline
                view={phraseTwoView({ compiled: true })}
                selection={{ panel: 'summary' }}
                onSelect={() => undefined}
            />
        );

        // Compiled Summary, phrase not started: the pane one click away holds a live start button, and the row
        // says so. The started mark is ABSENT — the two marks are anchored to different flags and must never
        // appear together.
        expect(ready.getByTestId('outline-plotlines-start').textContent).toBe('start');
        expect(ready.queryByTestId('outline-plotlines-state')).toBeNull();
        ready.unmount();

        // Nothing compiled: no prompt. This is the state an in-flight Phrase ① leaves the desk in, and a mark
        // here would offer a handoff the route would refuse.
        const waiting = render(
            <StoryOutline
                view={phraseTwoView({ compiled: false })}
                selection={{ panel: 'summary' }}
                onSelect={() => undefined}
            />
        );

        expect(waiting.queryByTestId('outline-plotlines-start')).toBeNull();
        expect(waiting.queryByTestId('outline-plotlines-state')).toBeNull();
        waiting.unmount();

        // Started: the prompt is gone for good (the handoff is one-way, D-72) and the row says `started`.
        const started = render(
            <StoryOutline
                view={phraseTwoView({ compiled: true, started: true, detail: phraseDetailView('s1') })}
                selection={{ panel: 'summary' }}
                onSelect={() => undefined}
            />
        );

        expect(started.queryByTestId('outline-plotlines-start')).toBeNull();
        expect(started.getByTestId('outline-plotlines-state').textContent).toBe('started');
        expect(
            started.getByTestId('outline-plotlines-state').getAttribute('title')
        ).toBe(
            'Phrase 2 has started: its Seed is copied, and its chapter entries are the surface you revise.'
        );
    });

    it('names the classic pipeline on the started mark when the dial is off (D-33)', () => {
        const { container } = render(
            <StoryOutline
                view={phraseTwoView({ mode: 'classic', started: true, compiled: true })}
                selection={{ panel: 'summary' }}
                onSelect={() => undefined}
            />
        );

        // A classic book's Phrase ② row must say which surface the pane opens, because the SAME flag drives both
        // pipelines and only the dial decides whether the Author sees entries or §4.3 records.
        expect(container.querySelector('[data-testid="outline-plotlines-state"]')?.getAttribute('title')).toBe(
            'Phrase 2 is running on the classic plotline tools: the pane shows the §4.3 records, not chapter entries.'
        );
        // And with the dial off, the phrase has no ENTRY rows: its records belong to the pane, not the rail. U-25
        // changes what "no rows" means — the phrase's own list exists, and it holds exactly the Seed row, because a
        // classic Phrase ② still has a Seed to read (its copied text, once started) and the rail must reach it.
        const classicChildren = container.querySelectorAll('#outline-children-plotlines .outline-child');

        expect(container.querySelector('#outline-children-plotlines')).toBeTruthy();
        expect(classicChildren).toHaveLength(1);
        expect(classicChildren[0]?.getAttribute('data-testid')).toBe('outline-seed');
        expect(classicChildren[0]?.querySelector('.outline-name')?.textContent).toBe('Seed');
        // …and the header's IDREF points at that list, which is the dangling-IDREF rule holding on a new frame.
        expect(plotlinesRow(container).getAttribute('aria-controls')).toBe('outline-children-plotlines');
    });

    // The entry rows are the pane's addresses, and the address is the row's id — the same rule U2 pins for a
    // Summary group. A rail that emitted `plotlines-group:1` (an index) would open the wrong contract.
    it('lists Phrase ②’s chapter entries as its children, in composition order (U2)', () => {
        const { container } = render(
            <StoryOutline
                view={phraseTwoView({ started: true, compiled: true, detail: phraseDetailView('s1') })}
                selection={{ panel: 'summary' }}
                onSelect={() => undefined}
            />
        );

        expect(
            Array.from(container.querySelectorAll('#outline-children-plotlines .outline-child .outline-name')).map(
                (row) => row.textContent
            )
            // U-25 — the Seed is Phrase ②'s first child, then the server's chapter entries in composition order.
        ).toEqual(['Seed', 'Chapter 1 — The Salt Road', 'Chapter 2 — The Salt Road', 'Chapter 3 — The Salt Road']);

        // The rail's children are under Phrase ②, never under the Summary's list: two entry lists, two parents.
        expect(container.querySelectorAll('#outline-children-plotlines .outline-child')).toHaveLength(4);
        expect(container.querySelector('#outline-plotlines-start')).toBeNull();
        expect(plotlinesRow(container).getAttribute('aria-controls')).toBe('outline-children-plotlines');
    });

    it('opens the chapter entry a row addresses, with the plotline ref (U2)', () => {
        const selections: StorySelection[] = [];
        const { container } = render(
            <StoryOutline
                view={phraseTwoView({ started: true, compiled: true, detail: phraseDetailView('s1') })}
                selection={{ panel: 'summary' }}
                onSelect={(next) => selections.push(next)}
            />
        );

        // The row IS the button (`StoryOutline.tsx`'s child row), so the rows are selected by the button's own class.
        const rows = Array.from(
            container.querySelectorAll<HTMLButtonElement>('#outline-children-plotlines button.outline-child')
        );

        // U-25 — row 0 is the phrase's Seed, so the entries start at 1.
        expect(rows).toHaveLength(4);

        // U-25 — the Seed row navigates as a child of ITS phrase: the phrase panel plus the synthetic seed ref, which
        // is the pair `StoryView` routes to that phrase's own Seed pane.
        fireEvent.click(rows[0]!);
        expect(selections[selections.length - 1]).toEqual({ panel: 'plotlines', ref: phraseSeedRef() });

        fireEvent.click(rows[2]!);
        // The header still drops the ref and opens the Overview, exactly as the Summary's does (U-21).
        fireEvent.click(plotlinesRow(container));

        expect(selections).toEqual([
            { panel: 'plotlines', ref: phraseSeedRef() },
            { panel: 'plotlines', ref: 'plotlines-group:entry-chapter_2' },
            { panel: 'plotlines' }
        ]);
    });

    it('tells a read in flight from a read that failed and from a phrase with no entries yet', () => {
        // In flight: the rows are on their way, and the rail says so instead of showing an empty phrase (U-11).
        const pending = render(
            <StoryOutline
                view={phraseTwoView({ mode: 'groups', started: true, compiled: true })}
                selection={{ panel: 'summary' }}
                onSelect={() => undefined}
            />
        );

        expect(pending.getByTestId('outline-plotlines-pending').textContent).toBe('reading the chapter entries…');
        expect(pending.queryByTestId('outline-plotlines-error')).toBeNull();
        pending.unmount();

        // Failed: the entries exist and are merely unread, and the server's own sentence is the actionable fact
        // (R-T2/F2, restated for the second phrase).
        const failed = render(
            <StoryOutline
                view={phraseTwoView({ started: true, compiled: true, detail: null })}
                selection={{ panel: 'summary' }}
                onSelect={() => undefined}
            />
        );

        expect(failed.getByTestId('outline-plotlines-error').textContent).toBe(
            'Chapter entries unread: the gateway is not answering'
        );
        expect(failed.getByTestId('outline-plotlines-error').getAttribute('title')).toBe(
            'the gateway is not answering'
        );
        failed.unmount();

        // Started on the grouped pipeline with NO entries: the brief has not been accepted, so the chapters do
        // not exist yet. A real state, and it names the wait rather than looking like an empty book.
        const empty = render(
            <StoryOutline
                view={phraseTwoView({
                    started: true,
                    compiled: true,
                    detail: phraseDetailView('s1', {
                        groups: [],
                        overview: '',
                        brief: { status: 'draft', chapter_count: 0 }
                    })
                })}
                selection={{ panel: 'summary' }}
                onSelect={() => undefined}
            />
        );

        expect(empty.getByTestId('outline-plotlines-empty').textContent).toBe(
            "no chapter entries yet — the phrase's brief has to be accepted before the chapters exist"
        );
        expect(empty.queryByTestId('outline-plotlines-pending')).toBeNull();
    });

    // Characters left the numbered rail but did not disappear: the sheet is one click away in the Supplements
    // section, and the selection it emits is byte-for-byte the one it always emitted, so the pane, its rows and
    // its tests need no change.
    it('opens the Characters sheet from the supplements row without a phrase number', () => {
        const selections: StorySelection[] = [];
        const { container } = render(
            <StoryOutline
                view={phraseTwoView()}
                selection={{ panel: 'characters' }}
                onSelect={(next) => selections.push(next)}
            />
        );

        const row = screen.getByRole('button', { name: 'Characters' });

        expect(row.closest('[data-testid="outline-supplements"]')).not.toBeNull();
        expect(row.className).not.toContain('outline-item--phrase');
        // It is the selection the pane already answers, and `aria-current` marks it as the open one.
        expect(row.getAttribute('aria-current')).toBe('page');

        fireEvent.click(row);

        expect(selections).toEqual([{ panel: 'characters' }]);
        // And the numbered rail itself holds no Characters row to compete with it.
        expect(
            Array.from(container.querySelectorAll('.outline-item--phrase .outline-name')).map((name) => name.textContent)
        ).toEqual(['Summary', 'Plotlines']);
    });
});

// ---------------------------------------------------------------------------
// R6 / U1+U2+U6 — the rail of a GROUP-managed book: the Summary phrase, and its five groups.
//
// `fixturePhrase()` is the phrase read as `server/api/projections.ts` sends it: the five groups from
// `shared/phrase`'s own catalog (composition order, and World rules deliberately absent), readable ids — a
// selection ref is the id STRING, so the dashboard never parses a uuid — three open findings (one shared by two
// groups, one the Reviewer never scoped, which R3 resolves against all five, and one minor), one `fixed` finding
// that must appear NOWHERE, one group the Writer is holding, and one never written.
//
// The numbers below are exact on purpose: the badge is `groupBlockingFindings` (the same read the Accept gate
// uses), so a badge that counted differently from the gate is the defect this file exists to catch. Promise has
// THREE open findings and badges TWO — the minor note is filed, not raised — and that pair is the assertion.
// ---------------------------------------------------------------------------
describe('StoryOutline — the Summary phrase’s five groups (R6)', () => {
    function groupView() {
        return fixtureView({ phrase: fixturePhrase() });
    }

    /** The Summary phrase's rows as (title, state mark, badge, score) — the whole list, so a reorder fails. */
    function rowsOfSummary(container: HTMLElement): Array<Array<string | null>> {
        const summary = Array.from(container.querySelectorAll<HTMLElement>('.outline-phase')).find((element) =>
            element.textContent?.includes('Summary')
        )!;

        return Array.from(summary.querySelectorAll<HTMLElement>('.outline-child')).map((row) => [
            row.querySelector('.outline-name')?.textContent ?? null,
            row.querySelector('[data-testid="outline-group-state"]')?.textContent ?? null,
            row.querySelector('.outline-badge')?.textContent ?? null,
            // T3 — the percentage, and `null` for a group the pass never scored (Ending). Reading it out of
            // the row rather than from the fixture is the point: a rail that printed the number in the wrong
            // row would still pass a name-only check.
            row.querySelector('[data-testid="outline-group-score"]')?.textContent ?? null
        ]);
    }

    it('lists the five groups as the phrase’s children, in composition order, and no Revision row (U1, U2)', () => {
        const { container } = render(
            <StoryOutline view={groupView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        expect(rowsOfSummary(container)).toEqual([
            // U-25 — the phrase's own Seed sits above its groups, and it wears none of a group row's marks: no
            // state word, no findings badge, no score. The row is the phrase's input, not a piece of its output.
            ['Seed', null, null, null],
            ['Premise', null, '1', '84%'],
            ['Promise', null, '2', '62%'],
            ['Theme', 'writer', '2', '71%'],
            ['Tone', null, '1', '58%'],
            ['Ending', 'to write', '1', null]
        ]);

        // U2 — the sampling rail's shape is gone for a grouped book: no `Revision N` row, and no row carries the
        // engine's draft state (the struck-out parked history was that rail's mark, and a group row has no such
        // state to strike).
        expect(container.textContent).not.toContain('Revision');
        expect(container.querySelectorAll('[data-state]')).toHaveLength(0);
        // U1 — five children, under the phrase headers the rail offers (Summary ① and Plotlines ② since T-W4; the
        // Plotlines row adds no child of the Summary's, and its own list is empty until Phrase ② is started).
        // U-25 adds one row to each list — the phrase's Seed — so the Summary's list is six deep.
        expect(container.querySelectorAll('.outline-item--phrase')).toHaveLength(2);
        expect(container.querySelectorAll('#outline-children-summary .outline-child')).toHaveLength(6);
        // The catalog's own order (premise → promise → theme → tone → ending), not a client-side sort: the row
        // order is what the Overview composes in — and the Seed comes before all five, because it is what the
        // Overview was written FROM.
        expect(
            Array.from(container.querySelectorAll('#outline-children-summary .outline-child .outline-name')).map(
                (row) => row.textContent
            )
        ).toEqual(['Seed', 'Premise', 'Promise', 'Theme', 'Tone', 'Ending']);
    });

    it('names each group row by its title plus only the state the wire reports (U6)', () => {
        render(
            <StoryOutline view={groupView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        // The accessible name is composed from the row's text (title, then one state word, then the badge's own
        // label) — never an `aria-label`, which would replace the name and swallow the badge. An unwritten group
        // says `to write`; a group the Writer is replacing says `writer`; a written group says NOTHING, because a
        // state word it has not earned would be decoration.
        // The full accessible name of each row, exactly: the group's TITLE, then one state word where the wire
        // reports one, then the badge's own label, then the attention mark's direction, then the group's score
        // (T3). No id, no revision number, and no run-together words (the separators are pinned by the strings
        // below — an accessible name is text, so flex `gap` cannot supply the boundary).
        //
        // The scores come from `fixturePhrase()`: two passes per written group, latest first, so the rail prints
        // 84 / 62 / 71 / 58 — and Ending, which has no `scores` key at all, prints NOTHING. That last row is the
        // whole absence rule: an unscored group that rendered `0%` would claim a review that never ran, and it
        // is also why this book's phrase header prints no overall average (one unscored group silences it).
        expect(
            screen.getByRole('button', {
                name: 'Premise 1 open Critical or Major finding open findings to answer Score 84%'
            })
        ).toBeTruthy();
        expect(
            screen.getByRole('button', {
                name: 'Promise 2 open Critical or Major findings open findings to answer Score 62%'
            })
        ).toBeTruthy();
        expect(
            screen.getByRole('button', {
                name: 'Theme writer 2 open Critical or Major findings open findings to answer Score 71%'
            })
        ).toBeTruthy();
        expect(
            screen.getByRole('button', {
                name: 'Tone 1 open Critical or Major finding open findings to answer Score 58%'
            })
        ).toBeTruthy();
        expect(
            screen.getByRole('button', {
                name: 'Ending to write 1 open Critical or Major finding open findings to answer'
            })
        ).toBeTruthy();

        // The state word exists once, and nowhere else: no duplicate copy that a screen reader would say twice.
        expect(document.querySelectorAll('[data-testid="outline-group-state"]')).toHaveLength(2);
        // T3 — and the score exists exactly where the wire scored: four numbers, and Ending has no node at all.
        expect(document.querySelectorAll('[data-testid="outline-group-score"]')).toHaveLength(4);
    });

    // T3 — the rail's ONE number per row, and the movement it cannot fit. The row shows the percentage and
    // nothing else (the column is 320px, and a column of digits is what the eye compares top to bottom); the
    // direction of travel is the fact the request asks for that the row has no room for, so it rides the row's
    // own `title`, the way the finding badge's sentence does. A first pass says so instead of implying a zero,
    // and a rewrite that went backwards says `down`.
    it('prints each group’s latest percentage and carries the movement in the row’s tooltip (T3)', () => {
        const { container } = render(
            <StoryOutline view={groupView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        const scores = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="outline-group-score"]'));

        // The five rows' numbers, in composition order, exactly — including the row that is absent (Ending),
        // which the length pins as much as the list below.
        expect(scores.map((score) => [score.textContent, score.getAttribute('title')])).toEqual([
            ['84%', 'Score 84% — up 6 from 78%'],
            ['62%', 'Score 62% — up 7 from 55%'],
            ['71%', 'Score 71% — the first pass over this group'],
            ['58%', 'Score 58% — down 6 from 64%']
        ]);

        // The number is never bare: `84%` on its own is not a name a reader can act on, so the span labels
        // itself with what it is, and the `title` adds the direction rather than replacing it.
        expect(scores[0].getAttribute('aria-label')).toBe('Score 84%');
        expect(scores[3].getAttribute('aria-label')).toBe('Score 58%');
    });

    // T3 — the phrase header's OVERALL score: the mean of every group's latest percentage. `fixturePhrase()`
    // has one unscored group, so THIS book's header must stay silent; the five scored groups of
    // `groupedPhraseView` (84/76/70/88/66) are what produces a number — 384 / 5 = 76.8 → `77%`. Averaging the
    // four rows that happened to arrive would print a number the server never claimed.
    it('averages the five groups onto the phrase header only when every group is scored (T3)', () => {
        const { container: silent } = render(
            <StoryOutline view={groupView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        expect(silent.querySelector('[data-testid="outline-phrase-score"]')).toBeNull();

        const { container: scored } = render(
            <StoryOutline
                view={fixtureView({ phrase: groupedPhraseView('s1') })}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={() => undefined}
            />
        );

        const header = scored.querySelector<HTMLElement>('[data-testid="outline-phrase-score"]')!;

        expect(header.textContent).toBe('77%');
        expect(header.getAttribute('aria-label')).toBe('Overall score 77%');
        // The header prints one number, so the breakdown behind it lives in the tooltip — in composition
        // order, with the group titles the rail itself uses.
        expect(header.getAttribute('title')).toBe(
            'Overall score — the average of every group: Premise 84%, Promise 76%, Theme 70%, Tone 88%, Ending 66%'
        );
        // …and the five rows still show their own numbers beside it: the average replaces nothing.
        expect(
            Array.from(scored.querySelectorAll('[data-testid="outline-group-score"]')).map((row) => row.textContent)
        ).toEqual(['84%', '76%', '70%', '88%', '66%']);
    });

    // T3 — the row is ONE control. The score and the movement had nowhere to go except inside a button that
    // already navigates, and an interactive element inside a button (`<details>`, a nested `<button>`, a link)
    // is a control a keyboard user cannot reach and a screen reader reports as a broken name. So the score is a
    // plain SPAN whose tooltip carries the trail: the row stays a leaf.
    it('keeps the score inside the row as text, never as a second control (T3)', () => {
        const { container } = render(
            <StoryOutline view={groupView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        const rows = Array.from(container.querySelectorAll<HTMLElement>('#outline-children-summary .outline-child'));

        // U-25 — six rows: the Seed first, then the five groups. The promise of the test is unchanged for every row,
        // and the Seed row is held to it too (a leaf, one BUTTON, nothing interactive inside it).
        expect(rows).toHaveLength(6);
        expect(rows.map((row) => row.tagName)).toEqual([
            'BUTTON',
            'BUTTON',
            'BUTTON',
            'BUTTON',
            'BUTTON',
            'BUTTON'
        ]);
        // Nothing interactive hides inside any row — the four scored rows, the unscored one and the Seed alike.
        expect(
            rows.map((row) =>
                Array.from(row.querySelectorAll('button, a[href], input, select, textarea, summary, [role="button"]'))
                    .map((element) => element.tagName)
            )
        ).toEqual([[], [], [], [], [], []]);
        // …and the score itself is a span, so its `aria-label` adds to the row's name rather than splitting it.
        expect(
            Array.from(container.querySelectorAll('[data-testid="outline-group-score"]')).map((score) => score.tagName)
        ).toEqual(['SPAN', 'SPAN', 'SPAN', 'SPAN']);
    });

    it('badges a group only with its critical/major findings (U6)', () => {
        const { container } = render(
            <StoryOutline view={groupView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        // Promise carries three OPEN findings and badges two: `f-minor` is a note at a cost the Story's dial
        // tolerates, so it is filed rather than raised — and the rail counts the SAME band the Overview row and
        // the pane badge print (`groupBlockingFindings` → `summaryBlockingCost`, dial included). D-78 — that
        // band is a severity reading, not a door: the Accept gate waits for none of these rows.
        // U-25 — the rows list starts with the phrase's Seed, so the groups are at 1…5.
        const promise = rowsOfSummary(container)[2];

        expect(promise[2]).toBe('2');

        // A `fixed` finding is archived out of every active list: it is in no badge and no row. The count is the
        // proof (a group with one finding that is fixed shows no badge at all), so a rendering that leaked it
        // would move Premise's badge from 1 to 2.
        const premise = rowsOfSummary(container)[1];

        expect(premise[2]).toBe('1');
        // …and the Seed row that opens this phrase's pane carries no badge of its own: a Seed has no findings to
        // answer, and a dot or a number on it would be a claim about a pinned text.
        expect(rowsOfSummary(container)[0]).toEqual(['Seed', null, null, null]);
    });

    it('keeps the group rows inside the disclosure the phrase header governs (U-21 + U1)', () => {
        const { container } = render(
            <StoryOutline view={groupView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        const summary = Array.from(container.querySelectorAll<HTMLButtonElement>('.outline-item--phrase')).find(
            (element) => element.querySelector('.outline-name')?.textContent === 'Summary'
        )!;

        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(summary.getAttribute('aria-controls')).toBe('outline-children-summary');

        fireEvent.click(summary);

        expect(summary.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('#outline-children-summary')).toBeNull();
        expect(rowsOfSummary(container)).toEqual([]);

        // Re-expanding restores the same rows, in the same order, with the same marks, badges and
        // percentages: folding a phrase hides the groups, it never recomputes or drops them. U-25 — the Seed row is
        // part of that list, so it folded with them (nothing else on the rail could hold it) and it comes back first.
        fireEvent.click(summary);

        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(rowsOfSummary(container)).toEqual([
            ['Seed', null, null, null],
            ['Premise', null, '1', '84%'],
            ['Promise', null, '2', '62%'],
            ['Theme', 'writer', '2', '71%'],
            ['Tone', null, '1', '58%'],
            ['Ending', 'to write', '1', null]
        ]);
    });

    // U-25 — THE SEED ROWS THEMSELVES. Each Phrase gets exactly one, first, named `Seed`, addressed by the synthetic
    // seed ref on its OWN panel: that pair is what `StoryView` routes to the phrase's Seed pane, so a rail row that
    // emitted `panel:'seed'` (the retired selection) or a shared ref for both phrases would open the wrong text.
    it('gives every phrase its own Seed row, first, and navigates it as a child of that phrase', () => {
        const selections: StorySelection[] = [];
        const { container } = render(
            <StoryOutline
                view={groupView()}
                selection={{ panel: 'plotlines', ref: phraseSeedRef() }}
                onSelect={(next) => selections.push(next)}
            />
        );

        // Two phrases, two Seed rows, one per list — and each row still wears the rail's Seed class, so the
        // stylesheet's rule for a Seed row is the rule for this row (`app.css`'s `.outline-item--seed`).
        const summarySeed = container.querySelector<HTMLElement>('#outline-children-summary [data-testid="outline-seed"]')!;
        const plotlinesSeed = container.querySelector<HTMLElement>('#outline-children-plotlines [data-testid="outline-seed"]')!;

        expect(summarySeed.querySelector('.outline-name')?.textContent).toBe('Seed');
        expect(plotlinesSeed.querySelector('.outline-name')?.textContent).toBe('Seed');
        expect(summarySeed.className).toContain('outline-child');
        expect(summarySeed.className).toContain('outline-item--seed');

        // FIRST in its list, ahead of the groups (the phrase reads top-down: input, then what was written from it).
        expect(
            container.querySelectorAll('#outline-children-summary .outline-child')[0]?.getAttribute('data-testid')
        ).toBe('outline-seed');

        // The lit row is the one the selection addresses — and only that one, because the ref is per phrase.
        expect(plotlinesSeed.className).toContain('outline-child--active');
        expect(summarySeed.className).not.toContain('outline-child--active');

        // A bare click navigates to that phrase's Seed, and the row is a leaf: no tooltip, no state, no badge.
        fireEvent.click(summarySeed);

        expect(selections).toEqual([{ panel: 'summary', ref: phraseSeedRef() }]);
        expect(summarySeed.hasAttribute('title')).toBe(false);
        expect(summarySeed.hasAttribute('data-state')).toBe(false);
        expect(summarySeed.querySelector('.outline-badge')).toBeNull();
        expect(summarySeed.querySelector('[data-testid="outline-group-score"]')).toBeNull();
        // U-25 — and no attention mark: `storyAttention` never names the seed ref, so the row inherits neither the
        // phrase header's dot nor one of its own (`attentionFor` answers `undefined`, and `data-attention` is absent).
        expect(summarySeed.className).not.toContain('outline-item--attention');
        expect(summarySeed.hasAttribute('data-attention')).toBe(false);
        // The accessible name is the word and nothing else: the row is one BUTTON labelled `Seed`, with no phrase
        // number and no mark text glued onto it.
        expect(summarySeed.tagName).toBe('BUTTON');
        expect(summarySeed.textContent).toBe('Seed');
        expect(plotlinesSeed.textContent).toBe('Seed');
        expect(screen.getAllByRole('button', { name: 'Seed' })).toHaveLength(2);
    });
});
