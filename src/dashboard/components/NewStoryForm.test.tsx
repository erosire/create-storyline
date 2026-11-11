// U-12 (usable with zero harnesses: the Author writes the Seed) + D-3b (the chapter count is
// declared by the Author, never proposed) + P5 (an empty Seed gives phase ① nothing to work against).
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { NewStoryForm } from './NewStoryForm';
import { click, renderShell, type } from '../testing/shell-fakes';

describe('NewStoryForm — the entry point (U-12 / D-3b)', () => {
    it('keeps the create disabled until the Seed exists (P5)', async () => {
        await renderShell(<NewStoryForm />);

        const create = screen.getByTestId('field-create') as HTMLButtonElement;
        expect(create.disabled).toBe(true);

        await type(screen.getByTestId('field-title'), 'The Second Death');
        expect(create.disabled).toBe(true);

        await type(screen.getByTestId('field-seed'), 'a cartographer maps the sea that ate her fleet');
        expect(create.disabled).toBe(false);
    });

    it('creates the Story with the declared chapter count and opens it (U-12 / D-3b)', async () => {
        const { client, store } = await renderShell(<NewStoryForm />);

        await type(screen.getByTestId('field-title'), 'The Second Death');
        await type(screen.getByTestId('field-seed'), 'a cartographer maps the sea that ate her fleet');
        // A hard fact gets a number field: 7 chapters means 7 plotlines, or C-0 fails (D-3b).
        await type(screen.getByTestId('field-chapters'), '7');

        await click(screen.getByTestId('field-create'));

        expect(client.createStory).toHaveBeenCalledTimes(1);
        expect(client.createStory).toHaveBeenCalledWith({
            title: 'The Second Death',
            idea: 'a cartographer maps the sea that ate her fleet',
            chapter_count: 7
        });
        // The new Story becomes THE STORY at once: the Author just wrote a Seed, and the next
        // thing they do is work phase ① against it.
        expect(store.getSnapshot().activeStoryId).toBe('story_new');
        expect((screen.getByTestId('field-seed') as HTMLTextAreaElement).value).toBe('');
    });
});
