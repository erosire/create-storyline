// U-10 / U-10a / U-10b — the home screen: the desk, grouped by Story, one click per decision.
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { AuthorQueue } from './AuthorQueue';
import { click, queueItem, renderShell, type } from '../testing/shell-fakes';
import type { QueueItem } from '../api';

function desk(): QueueItem[] {
    return [
        // As the Editor rewrote it (D-34a): the claim, the evidence line, the cost.
        queueItem('finding_1'),
        queueItem('idea_1', {
            kind: 'idea',
            title: 'the sea should have a name the cartographer refuses to say aloud',
            detail: 'a Critic filed it from the Sargasso passage; the Editor verified the page',
            evidence: 'verified · p.112 "she would not name it, for fear it would hear"'
        }),
        queueItem('escalation_1', {
            kind: 'escalation',
            story_id: 'story_2',
            story_title: 'Salt Cartography',
            title: 'should the sea have a name at all? the Summary says nameless, chapter 6 names it',
            detail: 'two crews took the contradiction in opposite directions; only the Author can settle it',
            evidence: 'summary: "the sea is nameless" · ch6 ¶2 "the Salt Cartography" '
        }),
        queueItem('gap_1', {
            kind: 'tool_gap',
            story_id: 'story_2',
            story_title: 'Salt Cartography',
            title: 'compare two chapters side by side',
            detail: 'the brief asked for a parallel read of ch4 and ch9; no tool returns both',
            evidence: 'BRIEF: "read ch4 and ch9 against each other"'
        })
    ];
}

const items = () => Array.from(document.querySelectorAll<HTMLElement>('li.queue-item'));

describe('AuthorQueue — the home screen (U-10 / U-10a / U-10b)', () => {
    it('groups the desk by Story and headlines how many Stories need the Author (U-10)', async () => {
        await renderShell(<AuthorQueue />, [], desk());

        expect(screen.getByTestId('queue-headline').textContent).toBe('2 stories need you');
        const groups = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="queue-group"]'));
        expect(groups.map((group) => group.dataset.story)).toEqual(['story_1', 'story_2']);
        // The finding and the Idea belong to story_1; the escalation and the gap to story_2.
        expect(groups[0]?.querySelectorAll('li.queue-item')).toHaveLength(2);
        expect(groups[1]?.querySelectorAll('li.queue-item')).toHaveLength(2);
    });

    it('renders a finding as the Editor wrote it — claim, evidence line, cost, and two buttons (U-10a / D-34)', async () => {
        await renderShell(<AuthorQueue />, [], desk());

        const findingEl = items()[0] as HTMLElement;
        const finding = within(findingEl);
        expect(finding.getByRole('heading', { level: 4 }).textContent).toBe(
            'the mentor dies twice, and the second death goes unnoticed'
        );
        expect(findingEl.querySelector('.queue-item__evidence-text')?.textContent).toBe(
            'ch3 ¶4 "he died on the beach" · ch9 ¶1 "the mentor corrected the map"'
        );
        expect(findingEl.querySelector('.cost-chip')?.textContent).toBe('major');
        expect(findingEl.querySelector('.cost-chip')?.getAttribute('data-cost')).toBe('major');
        // Exactly the two buttons U-10a names — nothing else competes with the decision.
        expect(finding.getAllByRole('button').map((button) => button.textContent)).toEqual(['Approve', 'Discard']);
    });

    // T3 — the row says WHAT it claims before it says what repairing it costs. `cost` has always been the price
    // of a repair; `finding_kind` is the claim type, and on this screen every row is a decision the Author makes
    // one at a time (U-10a), so an improvement must not read in the same voice as a defect. Three cases are
    // pinned: the explicit Issue, the explicit Proposal, and the legacy row that names no kind (which reads as
    // an Issue, never blank). The Idea row carries the field from the fixture default and shows NOTHING — the
    // claim type belongs to findings, and a chip on an Idea would be the desk inventing a classification.
    it('labels a finding row with its claim type, before the cost, and labels the other flavours with none (T3)', async () => {
        await renderShell(<AuthorQueue />, [], [
            queueItem('finding_1'),
            queueItem('finding_2', {
                finding_kind: 'proposal',
                cost: 'minor',
                title: 'link the twist in chapter 3 to the opening image'
            }),
            queueItem('finding_legacy', { finding_kind: undefined, cost: 'critical' }),
            queueItem('idea_1', { kind: 'idea' })
        ]);

        expect(items().map((row) => row.querySelector('.kind-chip')?.textContent ?? null)).toEqual([
            'Issue',
            'Proposal',
            'Issue',
            null
        ]);
        // The stylesheet hook carries the SAME decision as the word, so a surface can never colour a label its
        // own text says differently.
        expect(
            items().map((row) => row.querySelector('.kind-chip')?.getAttribute('data-kind') ?? null)
        ).toEqual(['issue', 'proposal', 'issue', null]);

        // First in the meta line, ahead of the cost — the reader learns what kind of claim it is before its
        // price, which is the order the decision is actually made in.
        const meta = items()[1].querySelector('.queue-item__meta')!;

        expect(Array.from(meta.children).map((child) => child.className)).toEqual([
            'kind-chip kind-chip--proposal',
            'cost-chip',
            'queue-item__dial-note'
        ]);
    });

    it('approves one finding at a time, with the audit line, and offers no silent batch (U-10b / P11)', async () => {
        const { client } = await renderShell(<AuthorQueue />, [], desk());

        const finding = items()[0] as HTMLElement;
        await click(within(finding).getByRole('button', { name: 'Approve' }));
        expect(client.approveFinding).toHaveBeenCalledTimes(1);
        expect(client.approveFinding).toHaveBeenCalledWith(
            'story_1',
            'finding_1',
            'approved from the queue by the Author'
        );

        // U-10b: nothing on this screen approves "the rest" quietly.
        expect(screen.queryByRole('button', { name: /all|every|batch/i })).toBeNull();

        // A discard is its own decision, on its own row.
        await click(within(finding).getByRole('button', { name: 'Discard' }));
        expect(client.discardFinding).toHaveBeenCalledWith(
            'story_1',
            'finding_1',
            'discarded from the queue by the Author'
        );
    });

    it('selects an Idea, escalates a question with its wording, and names a tool gap as a request (U-15 / P7 / T-12)', async () => {
        const { client } = await renderShell(<AuthorQueue />, [], desk());

        const idea = items()[1] as HTMLElement;
        expect(within(idea).getByRole('button', { name: 'Select' })).toBeTruthy();
        expect(
            within(idea)
                .getAllByRole('button')
                .map((button) => button.textContent)
        ).toEqual(['Select', 'Discard', 'Defer']);
        await click(within(idea).getByRole('button', { name: 'Select' }));
        expect(client.selectIdea).toHaveBeenCalledWith('story_1', 'idea_1', 'selected from the queue by the Author');

        const escalation = items()[2] as HTMLElement;
        expect(within(escalation).getByRole('heading', { level: 4 }).textContent).toContain(
            'should the sea have a name at all?'
        );

        // P7's answer is on the request itself: one line to the Editor, no detour into the Story.
        await type(within(escalation).getByTestId('queue-answer'), 'the sea is nameless — make ch6 agree');
        await click(within(escalation).getByTestId('queue-answer-send'));
        expect(client.sendDirective).toHaveBeenCalledWith('story_2', 'the sea is nameless — make ch6 agree', []);

        const gap = items()[3] as HTMLElement;
        expect(gap.textContent).toContain('compare two chapters side by side');
    });

    it('says "nothing needs you" when the desk is empty (U-10)', async () => {
        await renderShell(<AuthorQueue />, [], []);
        expect(screen.getByTestId('author-queue').textContent).toBe('nothing needs you');
    });
});
