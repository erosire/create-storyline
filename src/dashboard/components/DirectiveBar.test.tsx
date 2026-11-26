// W12 smoke + U-9/D-19: the bar sends one line of intent, and it is not a chat box.
//
// U-9 now also means the bar speaks for the pane: the label line and artifact refs come from
// the rail's selection, so "make it colder" while looking at chapter 4 reaches the Editor as a
// direction about chapter 4 — not as a free-floating suggestion.
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { DirectiveBar } from './DirectiveBar';
import { click, renderShell, storyRow, storyView, type } from '../testing/shell-fakes';
// U-25 — the rail's Seed rows are addressed by this ref, and the bar has to speak for the one the rail is on.
import { phraseSeedRef } from './story-nav';
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

    // U-25 — THE SEED IS A PHRASE CHILD, AND THE BAR SPEAKS FOR THE ONE THE RAIL IS ON. The two rows the rail now
    // offers look identical (`Seed`) and are not the same text: Phrase ①'s Seed is the Author's idea, Phrase ②'s is
    // the copy that phrase was started from. A bar that fell through to its panel's default would say "Summary" or
    // "the plotline set" over a Seed, which is the sentence the Editor receives.
    it('addresses Phrase ①’s Seed with the Seed sentence it has always used (U-25)', async () => {
        const { client } = await renderShell(
            <DirectiveBar selection={{ panel: 'summary', ref: phraseSeedRef() }} />,
            rows(),
            [],
            {},
            'story_3'
        );

        expect(document.querySelector<HTMLElement>('.directive-bar__label')?.textContent).toBe('Seed → Editor');

        await type(screen.getByTestId('directive-input'), 'the seed stands — write to it');
        await click(screen.getByTestId('directive-send'));

        // No artifact refs: the Seed is the loop's input, not a row the server resolves one hop wider (P5).
        expect(client.sendDirective).toHaveBeenCalledWith('story_3', 'the seed stands — write to it', []);
    });

    it('addresses Phrase ②’s own Seed with its own sentence, not the plotline set’s (U-25)', async () => {
        const { client } = await renderShell(
            <DirectiveBar selection={{ panel: 'plotlines', ref: phraseSeedRef() }} />,
            rows(),
            [],
            {},
            'story_3'
        );

        // The label is the whole point of this suite: `Plotlines → Editor` is what the bar prints over the chapter
        // entries, and the same words over a Seed would tell the Editor to write a plotline.
        expect(document.querySelector<HTMLElement>('.directive-bar__label')?.textContent).toBe(
            'Plotlines → Seed → Editor'
        );

        await type(screen.getByTestId('directive-input'), 'the chapters should open on the road, not the archive');
        await click(screen.getByTestId('directive-send'));

        // The refs stay empty HERE, and that is the shell's real state rather than a shortcut: the phrase row's id
        // comes from `phraseDetail`, which the store fetches only for the grouped dial (`state.ts:phraseDetailWanted`),
        // and the fake Story view this harness opens is on the classic dial. So this case proves the SENTENCE and the
        // absence; the grouped frame, where the same bar sends `['phrase_plotlines_1']`, is the case below, and the
        // model itself is pinned in `story-nav.seed.test.ts`.
        expect(client.sendDirective).toHaveBeenCalledWith(
            'story_3',
            'the chapters should open on the road, not the archive',
            []
        );
    });

    it('addresses Phrase ②’s Seed with the phrase row’s id once that read is in the frame (U-25)', async () => {
        // THE GROUPED FRAME, which the case above cannot have: its Story sits on the classic dial, so the store never
        // fetches the Phrase ② read (`state.ts:phraseDetailWanted`) and its empty `refs` proves only that the bar
        // invents an address it was not given. Here the dial is on `groups`, the read arrives with the Story, and the
        // refs the bar sends are the phrase row's own id — the address the Editor resolves one hop wider.
        const grouped = storyView(rows()[0]!);
        grouped.plotlines_mode = 'groups';
        grouped.story.plotlines_mode = 'groups';

        const { client } = await renderShell(
            <DirectiveBar selection={{ panel: 'plotlines', ref: phraseSeedRef() }} />,
            rows(),
            [],
            { getStory: async () => grouped },
            'story_3'
        );

        // The sentence is the classic frame's, unchanged: the dial moves the address, never what the line is about.
        expect(document.querySelector<HTMLElement>('.directive-bar__label')?.textContent).toBe(
            'Plotlines → Seed → Editor'
        );

        await type(screen.getByTestId('directive-input'), 'the chapters should open on the road, not the archive');
        await click(screen.getByTestId('directive-send'));

        // `phrase_plotlines_1` is the id `shell-fakes.ts:phraseDetailView` carries — the same value
        // `story-nav.seed.test.ts` pins against the pure model, now pinned through the bar that sends it.
        expect(client.sendDirective).toHaveBeenCalledWith(
            'story_3',
            'the chapters should open on the road, not the archive',
            ['phrase_plotlines_1']
        );
    });
});
