// The harness listing: Rank A is the session's authority, delegates fold away.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { HarnessPanel } from './HarnessPanel';
import type { HarnessListing } from '../api';

const harnesses: HarnessListing[] = [
    {
        name: 'reviewer',
        title: 'Reviewer',
        description: 'A strict independent judge.',
        entry: 'reviewer',
        builtin: true,
        agents: [
            {
                name: 'reviewer',
                title: 'Reviewer',
                description: 'Judges plans and documents.',
                rank: 'A',
                entry: true
            },
            {
                name: 'summarizer',
                title: 'Summarizer',
                description: 'Condenses long reads.',
                rank: 'B',
                entry: false
            }
        ],
        rank_a: ['reviewer'],
        tool_count: 12
    }
];

describe('HarnessPanel — the agents available to a session', () => {
    it('renders the harness, its Rank A agent, and the delegate roster', () => {
        render(<HarnessPanel harnesses={harnesses} />);

        const panel = screen.getByTestId('harness-panel');
        expect(within(panel).getByText('Reviewer', { selector: '.hv-card__title' })).toBeTruthy();
        expect(within(panel).getByText('reviewer', { selector: '.hv-card__name' })).toBeTruthy();
        expect(within(panel).getByText('Rank A')).toBeTruthy();
        expect(within(panel).getByText('Reviewer', { selector: '.hv-agent__name' })).toBeTruthy();
        expect(within(panel).getByText('12 tools')).toBeTruthy();
        expect(within(panel).getByText('1 delegate below Rank A')).toBeTruthy();
        expect(within(panel).getByText('Summarizer')).toBeTruthy();
    });

    it('states that the catalogue is empty rather than drawing a blank rail', () => {
        render(<HarnessPanel harnesses={[]} />);

        expect(screen.getByText('the harness catalogue is empty')).toBeTruthy();
    });
});
