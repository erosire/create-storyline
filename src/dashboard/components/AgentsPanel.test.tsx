// The global agent tiles: the same four agents for every Story, with the live thread, the rank
// they all hold, the model each one asks for, and the last torn-down run named on the tile.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AgentsPanel } from './AgentsPanel';
import type { AgentStatusRow } from '../api';

const agent = (kind: string, title: string): AgentStatusRow => ({
    kind,
    title,
    status: 'idle',
    rank: 'A',
    entry: kind === 'writer',
    model: 'local/basalt',
    model_source: 'default',
    template_models: [],
    working: [],
    recent: []
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
        // The IDLE badge already says it; an idle tile carries no second sentence.
        expect(within(editor).queryByText(/no thread right now/)).toBeNull();
    });

    it('states the rank every agent holds and which agent is the entry point (R15)', () => {
        const ranks: AgentStatusRow[] = idle.map((row) =>
            row.kind === 'writer' ? { ...row, entry: true } : { ...row, entry: false }
        );

        render(<AgentsPanel agents={ranks} />);

        const panel = screen.getByTestId('agents-panel');
        expect(within(panel).getAllByText('Rank A')).toHaveLength(4);
        expect(within(panel).getAllByText('entry')).toHaveLength(1);

        const writer = panel.querySelector<HTMLElement>('[data-agent="writer"]')!;
        expect(within(writer).getByText('entry')).toBeTruthy();
    });

    it('states the model on the tile as plain text backed by the catalogue dropdown (U-8, T-6b)', () => {
        render(<AgentsPanel agents={idle} />);

        const writer = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="writer"]')!;
        const select = within(writer).getByLabelText(/model for Writer/) as HTMLSelectElement;

        expect(within(writer).getByText('Model:')).toBeTruthy();
        expect(select.value).toBe('local/basalt');
        // No provenance sentence: the model line is the model only.
        expect(within(writer).queryByText(/set for this agent/)).toBeNull();
        expect(within(writer).queryByText(/process default/)).toBeNull();
    });

    it('opens the model choices from the plain-text model itself, without an extra editor step (U-8)', () => {
        const onSetModel = vi.fn();

        render(<AgentsPanel agents={idle} models={['local/basalt', 'deepseek-r1']} onSetModel={onSetModel} />);

        const writer = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="writer"]')!;

        const select = within(writer).getByLabelText(/model for Writer/) as HTMLSelectElement;
        expect(Array.from(select.options).map((option) => option.value)).toEqual(['local/basalt', 'deepseek-r1']);

        fireEvent.change(select, { target: { value: 'deepseek-r1' } });

        expect(onSetModel).toHaveBeenCalledWith('writer', 'deepseek-r1');
    });

    it('does not need a provenance marker to tell where a model came from', () => {
        const configured = idle.map((agent) =>
            agent.kind === 'checker' ? { ...agent, model: 'deepseek-r1', model_source: 'agent' as const } : agent
        );

        render(<AgentsPanel agents={configured} />);

        const checker = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="checker"]')!;
        const select = within(checker).getByLabelText(/model for Checker/) as HTMLSelectElement;

        expect(select.value).toBe('deepseek-r1');
        expect(within(checker).queryByText(/set for this agent/)).toBeNull();
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

    it('keeps the model in effect selectable when the provider no longer lists it (U-8)', () => {
        render(<AgentsPanel agents={idle} models={['deepseek-r1']} />);

        const writer = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="writer"]')!;
        const select = within(writer).getByLabelText(/model for Writer/) as HTMLSelectElement;

        expect(select.value).toBe('local/basalt');
        expect(Array.from(select.options).map((option) => option.value)).toEqual(['local/basalt', 'deepseek-r1']);
    });

    it('clears an agent’s choice from the same inline dropdown (U-8, T-6b)', () => {
        const onSetModel = vi.fn();
        const configured = idle.map((row) =>
            row.kind === 'reader' ? { ...row, model: 'deepseek-r1', model_source: 'agent' as const } : row
        );

        render(<AgentsPanel agents={configured} onSetModel={onSetModel} />);

        const reader = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="reader"]')!;
        const select = within(reader).getByLabelText(/model for Reader/) as HTMLSelectElement;

        fireEvent.change(select, { target: { value: '' } });

        expect(onSetModel).toHaveBeenCalledWith('reader', null);
    });

    it('keeps a torn-down run visible with the reason it ended (S-3)', () => {
        const failed = idle.map((row) =>
            row.kind === 'checker'
                ? {
                      ...row,
                      recent: [
                          {
                              run_id: 'run_9',
                              story_id: 'story_1',
                              story_title: 'Hollow Sea',
                              work_item: 'wi_check_chapters_1',
                              state: 'failed' as const,
                              started_at: '2026-11-22T10:00:00.000Z',
                              ended_at: '2026-11-22T10:00:02.000Z',
                              end_reason:
                                  'failed — LLM provider fault: LLM provider returned 400 — Invalid value for `[0].function`: Field required',
                              no_op: true,
                              tokens: 0
                          }
                      ]
                  }
                : row
        );

        render(<AgentsPanel agents={failed} />);

        const checker = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="checker"]')!;

        expect(within(checker).getAllByText('failed').length).toBeGreaterThan(0);
        expect(
            within(checker).getAllByText(/Invalid value for `\[0\]\.function`: Field required/).length
        ).toBeGreaterThan(0);
        expect(within(checker).getAllByText('wi_check_chapters_1').length).toBeGreaterThan(0);
    });

    it('renders the four agent kinds even before the first roster read answers', () => {
        render(<AgentsPanel agents={[]} loading />);

        expect(document.querySelectorAll('.sv-agent-tile')).toHaveLength(4);
        expect(screen.getByText('reading the agent roster…')).toBeTruthy();
    });
});
