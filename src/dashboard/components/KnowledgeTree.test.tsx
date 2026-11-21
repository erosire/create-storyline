// The knowledge directory's reading surface: folders, entries, and the placeholder that keeps an
// empty section visible.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { KnowledgeTree } from './KnowledgeTree';
import type { StoryKnowledgeTree } from '../api';

const tree: StoryKnowledgeTree = {
    story_id: 'story_1',
    story_title: 'Hollow Sea',
    degraded: false,
    sections: [
        {
            key: 'summary',
            title: 'Summary',
            article_id: 'a1',
            updated_at: '2026-11-21T10:00:00.000Z',
            entries: [
                {
                    key: 'summary',
                    title: 'Summary',
                    body: 'Premise: a cartographer maps the sea that ate her fleet.',
                    tags: ['section:summary', 'entry:summary']
                }
            ]
        },
        {
            key: 'ideas',
            title: 'Ideas',
            article_id: 'a2',
            updated_at: '2026-11-21T10:00:00.000Z',
            entries: [
                {
                    key: 'ideas:empty',
                    title: 'Ideas',
                    body: 'The Ideas tray is empty for this phase.',
                    tags: ['section:ideas', 'placeholder']
                }
            ]
        }
    ]
};

describe('KnowledgeTree — the durable directory', () => {
    it('renders every folder with its count and its entries', () => {
        render(<KnowledgeTree tree={tree} />);

        const panel = screen.getByTestId('knowledge-tree');
        expect(within(panel).getByText('Knowledge')).toBeTruthy();
        expect(within(panel).getByText('Summary', { selector: '.kn-folder__title' })).toBeTruthy();
        expect(within(panel).getByText('Ideas', { selector: '.kn-folder__title' })).toBeTruthy();
        expect(
            within(panel).getByText('a cartographer maps the sea that ate her fleet.', { exact: false })
        ).toBeTruthy();
        expect(within(panel).getAllByText('1')).toHaveLength(2);
    });

    it('marks an empty folder as a placeholder instead of hiding it', () => {
        render(<KnowledgeTree tree={tree} />);

        const folders = document.querySelectorAll('.kn-folder');
        expect(folders).toHaveLength(2);

        const ideas = document.querySelector<HTMLElement>('.kn-folder[data-section="ideas"]');
        expect(ideas?.dataset.empty).toBe('true');
        expect(within(ideas as HTMLElement).getByText('empty')).toBeTruthy();
        expect(within(ideas as HTMLElement).getByText(/Ideas tray is empty/)).toBeTruthy();
    });

    it('says the store is degraded rather than pretending the fallback is durable', () => {
        render(<KnowledgeTree tree={{ ...tree, degraded: true }} />);

        expect(screen.getByText(/knowledge store did not answer/i)).toBeTruthy();
    });
});
