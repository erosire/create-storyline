// The global agent tiles: the same four agents for every Story, with the live thread named.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AgentsPanel } from './AgentsPanel';
import type { AgentStatusRow } from '../api';

const idle: AgentStatusRow[] = [
    { kind: 'writer', title: 'Writer', status: 'idle', working: [] },
    { kind: 'editor', title: 'Editor', status: 'idle', working: [] },
    { kind: 'reader', title: 'Reader', status: 'idle', working: [] },
    { kind: 'checker', title: 'Checker', status: 'idle', working: [] }
];

describe('AgentsPanel — the global roster', () => {
    it('renders four tiles and says which story and phase a running agent holds', () => {
        const working = idle.map((agent) =>
            agent.kind === 'writer'
                ? {
                      ...agent,
                      status: 'running' as const,
                      working: [
                          {
                              story_id: 'story_1',
                              story_title: 'Hollow Sea',
                              phase: 'chapters' as const,
                              role_name: 'writer',
                              work_item: 'run_1',
                              thread_id: 'thread-1',
                              started_at: 1
                          }
                      ]
                  }
                : agent
        );

        render(<AgentsPanel agents={working} />);

        const panel = screen.getByTestId('agents-panel');
        expect(within(panel).getByText('Agents — global (U-8)')).toBeTruthy();
        expect(within(panel).getByText('1 thread running')).toBeTruthy();

        const tiles = panel.querySelectorAll<HTMLElement>('.sv-agent-tile');
        expect(Array.from(tiles).map((tile) => tile.dataset.agent)).toEqual([
            'writer',
            'editor',
            'reader',
            'checker'
        ]);

        const writer = panel.querySelector<HTMLElement>('[data-agent="writer"]')!;
        expect(writer.dataset.status).toBe('running');
        expect(within(writer).getByText('Hollow Sea')).toBeTruthy();
        expect(within(writer).getByText('③ Chapters')).toBeTruthy();
        expect(within(writer).getByText('run_1')).toBeTruthy();
        expect(within(writer).getByText('running')).toBeTruthy();

        const editor = panel.querySelector<HTMLElement>('[data-agent="editor"]')!;
        expect(editor.dataset.status).toBe('idle');
        expect(within(editor).getByText('idle — no thread right now')).toBeTruthy();
    });

    it('renders the four agent kinds even before the first roster read answers', () => {
        render(<AgentsPanel agents={[]} loading />);

        expect(document.querySelectorAll('.sv-agent-tile')).toHaveLength(4);
        expect(screen.getByText('reading the agent roster…')).toBeTruthy();
    });
});
