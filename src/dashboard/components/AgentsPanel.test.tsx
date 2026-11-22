// The global employee tiles: the same four employees for every Story, with the rank they all hold,
// the model each one asks for, and the content-area switch that opens that employee's threads.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AgentsPanel } from './AgentsPanel';
import type { AgentStatusRow } from '../api';

const agent = (kind: string, title: string): AgentStatusRow => ({
    kind,
    title,
    status: 'idle',
    rank: 'A',
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

describe('AgentsPanel — the global employee roster', () => {
    it('renders four tiles and counts the running threads, without listing them on the rail', () => {
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
        expect(within(panel).getByText('Employee')).toBeTruthy();
        expect(within(panel).getByText('1 thread running')).toBeTruthy();

        const tiles = panel.querySelectorAll<HTMLElement>('.sv-agent-tile');
        expect(Array.from(tiles).map((tile) => tile.dataset.agent)).toEqual(['checker', 'editor', 'reader', 'writer']);

        const writer = panel.querySelector<HTMLElement>('[data-agent="writer"]')!;
        expect(writer.dataset.status).toBe('running');
        expect(within(writer).getByText('running')).toBeTruthy();
        // The rail names the agent; the thread's Story/phase/work item belong to the centre.
        expect(within(writer).queryByText('Hollow Sea')).toBeNull();
        expect(within(writer).queryByText('run_1')).toBeNull();

        const editor = panel.querySelector<HTMLElement>('[data-agent="editor"]')!;
        expect(editor.dataset.status).toBe('idle');
        // The IDLE badge already says it; an idle tile carries no second sentence.
        expect(within(editor).queryByText(/no thread right now/)).toBeNull();
    });

    it('opens that agent’s threads from anywhere on the tile except the model dropdown (U-8)', () => {
        const onSelectAgent = vi.fn();

        render(
            <AgentsPanel
                agents={idle}
                models={['local/basalt', 'deepseek-r1']}
                onSetModel={vi.fn()}
                onSelectAgent={onSelectAgent}
                selectedAgent="editor"
            />
        );

        const writer = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="writer"]')!;
        const editor = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="editor"]')!;

        fireEvent.click(within(writer).getByRole('button', { name: /open Writer threads/ }));
        expect(onSelectAgent).toHaveBeenCalledTimes(1);
        expect(onSelectAgent).toHaveBeenCalledWith('writer');

        // The whole tile is the switch, not just its head: a click on the card itself works too.
        fireEvent.click(writer);
        expect(onSelectAgent).toHaveBeenCalledTimes(2);
        expect(onSelectAgent).toHaveBeenLastCalledWith('writer');

        // The model line's label and blank space belong to the tile…
        fireEvent.click(within(writer).getByText('Model:'));
        expect(onSelectAgent).toHaveBeenCalledTimes(3);
        fireEvent.click(writer.querySelector<HTMLElement>('.sv-agent-tile__model')!);
        expect(onSelectAgent).toHaveBeenCalledTimes(4);

        // …but the dropdown itself is its own control: opening it never opens the employee.
        fireEvent.click(within(writer).getByLabelText(/model for Writer/));
        expect(onSelectAgent).toHaveBeenCalledTimes(4);

        expect(writer.dataset.selected).toBe('false');
        expect(editor.dataset.selected).toBe('true');
        expect(
            within(editor)
                .getByRole('button', { name: /open Editor threads/ })
                .getAttribute('aria-pressed')
        ).toBe('true');
    });

    it('states the rank every employee holds, and invents no Entry role (R15)', () => {
        render(<AgentsPanel agents={idle} />);

        const panel = screen.getByTestId('agents-panel');
        expect(within(panel).getAllByText('Rank A')).toHaveLength(4);
        // The Author's channel is the Editor, but "Entry" is not a concept the roster draws.
        expect(within(panel).queryByText(/entry/i)).toBeNull();

        const editor = panel.querySelector<HTMLElement>('[data-agent="editor"]')!;
        expect(within(editor).getByText('Editor')).toBeTruthy();
        expect(within(panel).queryByText(/the Editor is your channel/)).toBeNull();
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

    it('does not duplicate the retained thread history on the rail (it belongs to the content area)', () => {
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

        expect(within(checker).queryByText(/Invalid value/)).toBeNull();
        expect(within(checker).queryByText('wi_check_chapters_1')).toBeNull();
        // The tile still says the agent is idle (the failed thread is history, not a live one).
        expect(within(checker).getByText('idle')).toBeTruthy();
    });

    it('renders the four employee kinds even before the first roster read answers', () => {
        render(<AgentsPanel agents={[]} loading />);

        expect(document.querySelectorAll('.sv-agent-tile')).toHaveLength(4);
        expect(screen.getByText('reading the agent roster…')).toBeTruthy();
    });
});
