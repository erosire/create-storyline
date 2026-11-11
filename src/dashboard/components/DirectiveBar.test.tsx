// W12 smoke + U-9/D-19: the bar sends one line of intent, and it is not a chat box.
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { DirectiveBar } from './DirectiveBar';
import { click, renderShell, storyRow, type } from '../testing/shell-fakes';

const rows = () => [storyRow('story_3', { title: 'Second Death', phase: 'chapters', status: 'ready' })];

describe('DirectiveBar — one line of Author intent (U-9 / D-19)', () => {
    it('sends the line as a directive on the selected Story and empties the bar (W12)', async () => {
        const { client } = await renderShell(<DirectiveBar />, rows(), [], {}, 'story_3');

        const input = screen.getByTestId('directive-input');
        // U-9's own example copy is the placeholder — the bar accepts decisions, and it says
        // so in the shape of one.
        expect(input.getAttribute('placeholder')).toBe('kill the mentor in ch4 · make it colder');

        await type(input, '  kill the mentor in ch4  ');
        await click(screen.getByTestId('directive-send'));

        expect(client.sendDirective).toHaveBeenCalledTimes(1);
        expect(client.sendDirective).toHaveBeenCalledWith('story_3', 'kill the mentor in ch4');
        // One line in, one line gone: no transcript is kept (U-9, §13 "not a chat client").
        expect((screen.getByTestId('directive-input') as HTMLInputElement).value).toBe('');
    });

    it('refuses to broadcast without a Story, and keeps no conversation of its own (U-9 / T-3)', async () => {
        const { container } = await renderShell(<DirectiveBar />, rows());

        expect((screen.getByTestId('directive-input') as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByTestId('directive-send') as HTMLButtonElement).disabled).toBe(true);
        expect(document.querySelector<HTMLElement>('.directive-bar__hint')?.textContent).toContain(
            'pick a Story first'
        );

        // The anti-chat check: a directive bar has no message list, no scroll region, and no
        // history element — the response is the Story changing, not a reply.
        expect(container.querySelectorAll('ul, ol, [data-transcript], [data-thread]')).toHaveLength(0);
    });
});
