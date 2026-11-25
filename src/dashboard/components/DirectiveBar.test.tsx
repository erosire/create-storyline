// W12 smoke + U-9/D-19: the bar sends one line of intent, and it is not a chat box.
//
// U-9 now also means the bar speaks for the pane: the label line and artifact refs come from
// the rail's selection, so "make it colder" while looking at chapter 4 reaches the Editor as a
// direction about chapter 4 — not as a free-floating suggestion.
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { DirectiveBar } from './DirectiveBar';
import { click, renderShell, storyRow, storyView, type } from '../testing/shell-fakes';
import type { Chapter } from '../../shared/types';

const rows = () => [storyRow('story_3', { title: 'Second Death', phase: 'chapters', status: 'ready' })];

function chapter(id: string, order: number, title: string): Chapter {
    return {
        id,
        rev: 1,
        created_at: '2026-11-09T10:00:00.000Z',
        updated_at: '2026-11-09T10:00:00.000Z',
        story_id: 'story_3',
        order,
        title,
        sections: [],
        state: 'drafting',
        author_locked: false,
        round: 1
    };
}

describe('DirectiveBar — one line of Author intent (U-9 / D-19)', () => {
    it('sends the line as a directive on the selected Story and empties the bar (W12)', async () => {
        const { client } = await renderShell(<DirectiveBar />, rows(), [], {}, 'story_3');

        const input = screen.getByTestId('directive-input');
        expect(document.querySelector<HTMLElement>('.directive-bar__label')?.textContent).toBe('Summary → Editor');

        await type(input, '  kill the mentor in ch4  ');
        await click(screen.getByTestId('directive-send'));

        expect(client.sendDirective).toHaveBeenCalledTimes(1);
        expect(client.sendDirective).toHaveBeenCalledWith('story_3', 'kill the mentor in ch4', []);
        // No hint line: the label line over the field is the whole explanation of what the input does.
        expect(document.querySelector('.directive-bar__hint')).toBeNull();
        // One line in, one line gone: no transcript is kept (U-9, §13 "not a chat client").
        expect((screen.getByTestId('directive-input') as HTMLInputElement).value).toBe('');
    });

    it('changes the direction to the chapter the Author is reading (U-9 / U-4)', async () => {
        const view = storyView(rows()[0]!);
        view.chapters = [chapter('c4', 4, 'Act Two, Drowned')];
        const { client } = await renderShell(
            <DirectiveBar selection={{ panel: 'chapters', ref: 'c4' }} />,
            rows(),
            [],
            { getStory: async () => view },
            'story_3'
        );

        expect(document.querySelector<HTMLElement>('.directive-bar__label')?.textContent).toBe(
            'Chapter 4 — Act Two, Drowned → Editor'
        );

        await type(screen.getByTestId('directive-input'), 'kill the mentor here');
        await click(screen.getByTestId('directive-send'));

        expect(client.sendDirective).toHaveBeenCalledWith('story_3', 'kill the mentor here', ['c4']);
    });

    it('starts a Story from the prompt and sends it to that Story’s Editor (U-9 / U-12)', async () => {
        const { client, container } = await renderShell(<DirectiveBar />, rows());

        expect(document.querySelector<HTMLElement>('.directive-bar__label')?.textContent).toBe('Directive');
        expect((screen.getByTestId('directive-input') as HTMLInputElement).disabled).toBe(false);

        const direction = 'create me a story about a cartographer who maps the sea that ate her fleet';
        await type(screen.getByTestId('directive-input'), direction);
        await click(screen.getByTestId('directive-send'));

        // The prompt is the Seed; the server names the Story, and the Editor receives the same
        // sentence as its first direction — no form required.
        expect(client.createStory).toHaveBeenCalledWith({ idea: direction });
        expect(client.sendDirective).toHaveBeenCalledWith('story_new', direction, []);

        // The anti-chat check: a directive bar has no message list, no scroll region, and no
        // history element — the response is the Story changing, not a reply.
        expect(container.querySelectorAll('ul, ol, [data-transcript], [data-thread]')).toHaveLength(0);
    });

    it('labels the prompt with the home action it will perform (U-9 / U-12)', async () => {
        await renderShell(<DirectiveBar homeTab="create" />, rows());

        expect(document.querySelector<HTMLElement>('.directive-bar__label')?.textContent).toBe(
            'Create New Story'
        );
    });
});
