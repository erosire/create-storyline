// U-12 (usable with zero harnesses: the Author writes the Seed) + P5 (an empty Seed gives
// phase ① nothing to work against). Phase ① samples the Summary from the Seed, so the
// chapter count belongs to phase ② and is not asked for here.
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { NewStoryForm } from './NewStoryForm';
import { click, renderShell, type } from '../testing/shell-fakes';

describe('NewStoryForm — the entry point (U-12)', () => {
    it('keeps the create disabled until the Seed exists (P5)', async () => {
        await renderShell(<NewStoryForm />);

        const create = screen.getByTestId('field-create') as HTMLButtonElement;
        expect(create.disabled).toBe(true);

        await type(screen.getByTestId('field-title'), 'The Second Death');
        expect(create.disabled).toBe(true);

        await type(screen.getByTestId('field-seed'), 'a cartographer maps the sea that ate her fleet');
        expect(create.disabled).toBe(false);
    });

    it('creates the Story from the Seed without asking for a chapter count (phase ①)', async () => {
        const { client, store } = await renderShell(<NewStoryForm />);

        expect(screen.queryByTestId('field-chapters')).toBeNull();

        await type(screen.getByTestId('field-title'), 'The Second Death');
        await type(screen.getByTestId('field-seed'), 'a cartographer maps the sea that ate her fleet');

        await click(screen.getByTestId('field-create'));

        expect(client.createStory).toHaveBeenCalledTimes(1);
        expect(client.createStory).toHaveBeenCalledWith({
            title: 'The Second Death',
            idea: 'a cartographer maps the sea that ate her fleet'
        });
        // The new Story becomes THE STORY at once: the Author just wrote a Seed, and the next
        // thing they do is work phase ① against it.
        expect(store.getSnapshot().activeStoryId).toBe('story_new');
        expect((screen.getByTestId('field-seed') as HTMLTextAreaElement).value).toBe('');
    });
});
