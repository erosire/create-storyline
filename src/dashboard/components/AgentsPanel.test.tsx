// The global employee tiles: the same five employees for every Story, with the rank they all hold,
// the model each one asks for, and the content-area switch that opens that employee's threads.
//
// R4 — the running badge's FACE is the count alone; the sentence ("4 threads running") stays on the
// badge's title/aria-label and inside the tile button's composed accessible name.
// R10 — each kind carries a `data-agent` hook that story.css turns into one persistent colour.
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
    agent('critic', 'Critic'),
    agent('reader', 'Reader'),
    // Phase ①'s Researcher is the fifth employee (§3.1): Rank A, writes only `knowledge`.
    agent('researcher', 'Researcher')
];

describe('AgentsPanel — the global employee roster', () => {
    it('shows the running badge as the bare count, with the sentence kept accessibly (R4)', () => {
        const working = idle.map((agent) =>
            agent.kind === 'writer'
                ? {
                      ...agent,
                      status: 'running' as const,
                      working: [1, 2, 3, 4].map((index) => ({
                          story_id: 'story_1',
                          story_title: 'Hollow Sea',
                          phase: 'chapters' as const,
                          role_name: 'writer',
                          work_item: `run_${index}`,
                          thread_id: `thread-${index}`,
                          started_at: index
                      }))
                  }
                : agent
        );

        render(<AgentsPanel agents={working} />);

        const panel = screen.getByTestId('agents-panel');
        expect(within(panel).getByText('Employee')).toBeTruthy();
        // The header stays the roster's name only: the count line lives on each tile, not above them.
        // (R2 put the sentence ON the badge, so the check is scoped to the header.)
        const header = panel.querySelector<HTMLElement>('.sv-pane-head')!;
        expect(within(header).queryByText(/threads? running/i)).toBeNull();

        const tiles = panel.querySelectorAll<HTMLElement>('.sv-agent-tile');
        // Alphabetical by title, five rows: the Researcher sorts between Editor and Writer.
        expect(Array.from(tiles).map((tile) => tile.dataset.agent)).toEqual([
            'critic',
            'editor',
            'reader',
            'researcher',
            'writer'
        ]);

        const writer = panel.querySelector<HTMLElement>('[data-agent="writer"]')!;
        expect(writer.dataset.status).toBe('running');
        const writerState = writer.querySelector<HTMLElement>('.sv-agent-tile__state')!;
        // R4: the face is the count and nothing else — the pill's blue is the "running" signal, so a
        // word would repeat what the colour already says. Exact, not a substring: no wording leaks in.
        expect(writerState.textContent).toBe('4');
        // ...and the sentence the face dropped is still the one answer hover and a screen reader get.
        expect(writerState.getAttribute('title')).toBe('4 threads running');
        expect(writerState.getAttribute('aria-label')).toBe('4 threads running');
        // The button's own aria-label REPLACES its subtree's name, so it carries the count in context.
        expect(within(writer).getByRole('button', { name: 'open Writer threads — 4 threads running' })).toBeTruthy();
        // Nothing on the tile spells the count out any more, and no "RUNNING" word doubles up beside it.
        expect(within(writer).queryByText(/threads? running/)).toBeNull();
        expect(within(writer).queryByText('running')).toBeNull();
        // The rail names the employee and counts its threads; Story/phase/work item stay in the centre.
        expect(within(writer).queryByText('Hollow Sea')).toBeNull();
        expect(within(writer).queryByText('run_1')).toBeNull();

        const editor = panel.querySelector<HTMLElement>('[data-agent="editor"]')!;
        expect(editor.dataset.status).toBe('idle');
        expect(editor.querySelector<HTMLElement>('.sv-agent-tile__state')?.textContent).toBe('idle');
        // The IDLE badge already says it; an idle tile carries no second sentence.
        expect(within(editor).queryByText(/no thread right now/)).toBeNull();
    });

    it('carries the loop’s ceiling in the header, to the right of the roster’s name (S-5)', () => {
        render(<AgentsPanel agents={idle} loop={{ global_max_concurrent: 8, live_runs: 6 }} onSetLoopLimit={vi.fn()} />);

        const panel = screen.getByTestId('agents-panel');
        const header = panel.querySelector<HTMLElement>('.sv-pane-head')!;
        const limit = within(header).getByRole('combobox', { name: /maximum threads the loop runs at once/i });

        // The number in effect, next to the title — not on a Story pane, because S-5's ceiling is one
        // value across every Story and this rail is the shell's only global column.
        expect(limit.textContent).toContain('8');
        expect(header.textContent).toContain('Max threads');
        // "To the right of it": the title keeps the left edge and the control is the header's last
        // child, which is where story.css's `margin-left: auto` puts it.
        expect(header.lastElementChild?.contains(limit)).toBe(true);
        // The live count stays in the hover sentence: the header still prints no running line of its
        // own, because every tile's badge already answers that question.
        expect(within(header).queryByText(/threads? running/i)).toBeNull();
        expect(limit.getAttribute('title')).toContain('6 live now');
    });

    it('leaves the header the roster’s name alone when the shell has no loop to configure', () => {
        render(<AgentsPanel agents={idle} />);

        const header = screen.getByTestId('agents-panel').querySelector<HTMLElement>('.sv-pane-head')!;

        expect(within(header).queryByRole('combobox')).toBeNull();
        expect(within(header).queryByText(/max threads/i)).toBeNull();
    });

    it('says "1 thread running" — singular — for the single run the server reconciles (R2, R4)', () => {
        // This is exactly what `GET /agents` now answers for a structured Writer run: one live
        // journaled row, no engine thread, so the tile has one working entry (R1).
        const oneThread = idle.map((agent) =>
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
                              work_item: 'wi_draft_chapter_1',
                              thread_id: 'run_row:run_1',
                              started_at: Date.parse('2026-11-23T10:00:00.000Z')
                          }
                      ]
                  }
                : agent
        );

        render(<AgentsPanel agents={oneThread} />);

        const writer = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="writer"]')!;
        const writerState = writer.querySelector<HTMLElement>('.sv-agent-tile__state')!;

        expect(writer.dataset.status).toBe('running');
        // R4 — the face is the singular count "1"; the sentence it dropped is singular too, and it is
        // still what hover and the screen reader hear (no "1 threads").
        expect(writerState.textContent).toBe('1');
        expect(writerState.getAttribute('title')).toBe('1 thread running');
        expect(writerState.getAttribute('aria-label')).toBe('1 thread running');
        expect(within(writer).getByRole('button', { name: 'open Writer threads — 1 thread running' })).toBeTruthy();
        expect(within(writer).queryByText(/threads? running/)).toBeNull();

        // Every other employee keeps the idle face: a running count never leaks onto its peers (R3).
        const titles: Record<string, string> = {
            reader: 'Reader',
            editor: 'Editor',
            critic: 'Critic',
            researcher: 'Researcher'
        };

        for (const [kind, title] of Object.entries(titles)) {
            const tile = screen.getByTestId('agents-panel').querySelector<HTMLElement>(`[data-agent="${kind}"]`)!;
            const state = tile.querySelector<HTMLElement>('.sv-agent-tile__state')!;

            expect(tile.dataset.status).toBe('idle');
            expect(state.textContent).toBe('idle');
            expect(state.getAttribute('title')).toBe('idle — no thread right now');
            expect(state.getAttribute('aria-label')).toBe(`${title} is idle`);
            // R4 — an idle tile's button name is exactly what it always was: the count sentence is
            // composed only for a running employee, so nothing is added where there is nothing to say.
            expect(within(tile).getByRole('button', { name: `open ${title} threads` })).toBeTruthy();
        }
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

    it('states the rank every employee holds, and invents no Entry role (V-2, D-38a)', () => {
        render(<AgentsPanel agents={idle} />);

        const panel = screen.getByTestId('agents-panel');
        expect(within(panel).getAllByText('Rank A')).toHaveLength(5);
        // The Author's channel is the Editor, but "Entry" is not a concept the roster draws.
        expect(within(panel).queryByText(/entry/i)).toBeNull();

        const editor = panel.querySelector<HTMLElement>('[data-agent="editor"]')!;
        expect(within(editor).getByText('Editor')).toBeTruthy();
        // The Researcher is a Rank A peer with its own tile — not a sub-role of the Critic.
        const researcher = panel.querySelector<HTMLElement>('[data-agent="researcher"]')!;
        expect(within(researcher).getByText('Researcher')).toBeTruthy();
        expect(within(panel).queryByText(/the Editor is your channel/)).toBeNull();
    });

    it('gives every employee the data hooks its own colour hangs on, in every state (R10)', () => {
        // The five hues are CSS-only: story.css keys `--agent-tint` (the left identity stripe and the
        // name) off `data-agent`, while `data-status` and the state pill's modifier class stay the
        // live/idle signal. jsdom cannot compute a colour, so what a test CAN pin is the contract the
        // stylesheet reads — the three hooks, unchanged in idle, running and selected.
        const stateClass = (kind: string): string =>
            screen
                .getByTestId('agents-panel')
                .querySelector<HTMLElement>(`[data-agent="${kind}"]`)!
                .querySelector<HTMLElement>('.sv-agent-tile__state')!.className;

        const { rerender } = render(<AgentsPanel agents={idle} />);

        // All five hooks exist while every employee is idle — the stripe has to show in the resting
        // state too, or it would only appear on the one tile that happens to be running.
        expect(
            Array.from(document.querySelectorAll<HTMLElement>('.sv-agent-tile')).map((tile) => tile.dataset.agent)
        ).toEqual(['critic', 'editor', 'reader', 'researcher', 'writer']);
        for (const kind of ['critic', 'editor', 'reader', 'researcher', 'writer']) {
            expect(document.querySelector<HTMLElement>(`[data-agent="${kind}"]`)?.dataset.status).toBe('idle');
            expect(document.querySelector<HTMLElement>(`[data-agent="${kind}"]`)?.dataset.selected).toBe('false');
            expect(stateClass(kind)).toBe('sv-agent-tile__state sv-agent-tile__state--idle');
            // R10 — no colour is computed in React: nothing here overrides the stylesheet inline.
            expect(document.querySelector<HTMLElement>(`[data-agent="${kind}"]`)?.hasAttribute('style')).toBe(false);
        }

        // Two live threads, so the badge counts 2 — enough to prove the state hooks switch while the
        // identity hook and the pill's own modifier class keep their separate jobs.
        const working = idle.map((row) =>
            row.kind === 'writer'
                ? {
                      ...row,
                      status: 'running' as const,
                      working: [1, 2].map((index) => ({
                          story_id: 'story_1',
                          story_title: 'Hollow Sea',
                          phase: 'chapters' as const,
                          role_name: 'writer',
                          work_item: `run_${index}`,
                          thread_id: `thread-${index}`,
                          started_at: index
                      }))
                  }
                : row
        );

        rerender(<AgentsPanel agents={working} selectedAgent="writer" />);

        // Running + selected: the identity hook survives both state changes (it never becomes the
        // status hook), the status hooks answer as before, and only the open tile reads as selected.
        expect(document.querySelector<HTMLElement>('[data-agent="writer"]')?.dataset.agent).toBe('writer');
        expect(document.querySelector<HTMLElement>('[data-agent="writer"]')?.dataset.status).toBe('running');
        expect(document.querySelector<HTMLElement>('[data-agent="writer"]')?.dataset.selected).toBe('true');
        expect(stateClass('writer')).toBe('sv-agent-tile__state sv-agent-tile__state--running');

        for (const kind of ['critic', 'editor', 'reader', 'researcher']) {
            expect(document.querySelector<HTMLElement>(`[data-agent="${kind}"]`)?.dataset.status).toBe('idle');
            expect(document.querySelector<HTMLElement>(`[data-agent="${kind}"]`)?.dataset.selected).toBe('false');
            expect(stateClass(kind)).toBe('sv-agent-tile__state sv-agent-tile__state--idle');
        }
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
            agent.kind === 'reader' ? { ...agent, model: 'deepseek-r1', model_source: 'agent' as const } : agent
        );

        render(<AgentsPanel agents={configured} />);

        const reader = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="reader"]')!;
        const select = within(reader).getByLabelText(/model for Reader/) as HTMLSelectElement;

        expect(select.value).toBe('deepseek-r1');
        expect(within(reader).queryByText(/set for this agent/)).toBeNull();
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
            row.kind === 'critic' ? { ...row, model: 'deepseek-r1', model_source: 'agent' as const } : row
        );

        render(<AgentsPanel agents={configured} onSetModel={onSetModel} />);

        const critic = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="critic"]')!;
        const select = within(critic).getByLabelText(/model for Critic/) as HTMLSelectElement;

        fireEvent.change(select, { target: { value: '' } });

        expect(onSetModel).toHaveBeenCalledWith('critic', null);
    });

    it('does not duplicate the retained thread history on the rail (it belongs to the content area)', () => {
        const failed = idle.map((row) =>
            row.kind === 'reader'
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

        const reader = screen.getByTestId('agents-panel').querySelector<HTMLElement>('[data-agent="reader"]')!;

        expect(within(reader).queryByText(/Invalid value/)).toBeNull();
        expect(within(reader).queryByText('wi_check_chapters_1')).toBeNull();
        // The tile still says the agent is idle (the failed thread is history, not a live one).
        expect(within(reader).getByText('idle')).toBeTruthy();
    });

    it('renders the five employee kinds even before the first roster read answers', () => {
        render(<AgentsPanel agents={[]} loading />);

        // The placeholders are the rail's whole promise: all five kinds appear before `GET /agents`
        // answers, so a slow read cannot make the Researcher (or anyone) look absent.
        expect(Array.from(document.querySelectorAll<HTMLElement>('.sv-agent-tile')).map((tile) => tile.dataset.agent)).toEqual([
            'critic',
            'editor',
            'reader',
            'researcher',
            'writer'
        ]);
        expect(screen.getByText('reading the agent roster…')).toBeTruthy();
    });
});
