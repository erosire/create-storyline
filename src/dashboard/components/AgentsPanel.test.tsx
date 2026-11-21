// The global agent tiles: the same four agents for every Story, with the live thread and the
// model each one asks for named on the face of the tile.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AgentsPanel } from './AgentsPanel';
import type { AgentStatusRow } from '../api';

const agent = (kind: string, title: string): AgentStatusRow => ({
    kind,
    title,
    status: 'idle',
    model: 'local/basalt',
    model_source: 'default',
    template_models: [],
    working: []
});

const idle: AgentStatusRow[] = [
    agent('writer', 'Writer'),
    agent('editor', 'Editor'),
    agent('reader', 'Reader'),
    agent('checker', 'Checker')
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
        expect(Array.from(tiles).map((tile) => tile.dataset.agent)).toEqual(['writer', 'editor', 'reader', 'checker']);

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

    it('lists the model every agent asks for and where it came from (U-8, T-6b)', () => {
        render(<AgentsPanel agents={idle} />);

        const writer = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="writer"]')!;

        expect(within(writer).getByText('local/basalt')).toBeTruthy();
        expect(within(writer).getByText('process default')).toBeTruthy();
    });

    it('marks a model the Author set on the roster as this agent’s own', () => {
        const configured = idle.map((agent) =>
            agent.kind === 'checker' ? { ...agent, model: 'deepseek-r1', model_source: 'agent' as const } : agent
        );

        render(<AgentsPanel agents={configured} />);

        const checker = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="checker"]')!;

        expect(within(checker).getByText('deepseek-r1')).toBeTruthy();
        expect(within(checker).getByText('set for this agent')).toBeTruthy();
    });

    it('discloses the template-role models that would otherwise govern the crew (T-6b)', () => {
        const withTemplateModel = idle.map((row) =>
            row.kind === 'writer'
                ? {
                      ...row,
                      template_models: [{ template: 'writer-chapters', role: 'writer', model: 'local-large' }]
                  }
                : row
        );

        render(<AgentsPanel agents={withTemplateModel} />);

        const writer = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="writer"]')!;

        expect(within(writer).getByText(/local-large \(writer-chapters\)/)).toBeTruthy();
        expect(within(writer).getByText(/they win over the process default/)).toBeTruthy();
    });

    it('opens the model editor from the tile and saves a model chosen from the provider catalog (U-8)', () => {
        const onSetModel = vi.fn();

        render(<AgentsPanel agents={idle} models={['local/basalt', 'deepseek-r1']} onSetModel={onSetModel} />);

        const writer = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="writer"]')!;

        fireEvent.click(within(writer).getByRole('button', { name: /Writer/ }));

        const select = within(writer).getByLabelText(/model for Writer/) as HTMLSelectElement;
        expect(select.tagName).toBe('SELECT');
        expect(select.value).toBe('local/basalt');
        expect(Array.from(select.options).map((option) => option.value)).toEqual(['local/basalt', 'deepseek-r1']);

        fireEvent.change(select, { target: { value: 'deepseek-r1' } });
        fireEvent.click(within(writer).getByRole('button', { name: 'Save model' }));

        expect(onSetModel).toHaveBeenCalledWith('writer', 'deepseek-r1');
    });

    it('keeps the model in effect selectable when the provider no longer lists it (U-8)', () => {
        render(<AgentsPanel agents={idle} models={['deepseek-r1']} />);

        const writer = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="writer"]')!;

        fireEvent.click(within(writer).getByRole('button', { name: /Writer/ }));

        const select = within(writer).getByLabelText(/model for Writer/) as HTMLSelectElement;
        expect(select.value).toBe('local/basalt');
        expect(Array.from(select.options).map((option) => option.value)).toEqual(['local/basalt', 'deepseek-r1']);
    });

    it('clears an agent’s choice (U-8, T-6b)', () => {
        const onSetModel = vi.fn();

        render(<AgentsPanel agents={idle} onSetModel={onSetModel} />);

        const reader = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="reader"]')!;

        fireEvent.click(within(reader).getByRole('button', { name: /Reader/ }));
        fireEvent.click(within(reader).getByRole('button', { name: "Clear this agent's choice" }));

        expect(onSetModel).toHaveBeenCalledWith('reader', null);
    });

    it('renders the four agent kinds even before the first roster read answers', () => {
        render(<AgentsPanel agents={[]} loading />);

        expect(document.querySelectorAll('.sv-agent-tile')).toHaveLength(4);
        expect(screen.getByText('reading the agent roster…')).toBeTruthy();
    });
});
