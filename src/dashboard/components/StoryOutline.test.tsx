// The left rail after the redesign: four phrases, their entries, and the supporting folders.
//
// The rail must say exactly that and nothing else: the old knowledge header's subtitle, note
// count and "one article per folder" sentence are the clutter the redesign removed, and the
// Summary's tick is the only status it paints.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StoryOutline } from './StoryOutline';
import { DEFAULT_STORY_SELECTION } from './story-nav';
import type { StorySelection } from './story-nav';
import { fixtureStory, fixtureSummary, fixtureView } from './story-fixtures';
import type { Cost, Finding, FindingState } from '../../shared/types';

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
});
