// §4.4 / D-7 / T-2 — the derived `content` read over sectioned prose.
import { chapterContent } from './chapter';
import type { Chapter, ChapterSection } from './types';

/** A §4.4 chapter whose prose is sections — the shape the store actually holds. */
function chapterWith(sections: ChapterSection[]): Chapter {
    return {
        id: 'chapter_1',
        rev: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        story_id: 'story_1',
        order: 1,
        title: 'The Reservoir',
        sections,
        state: 'drafting',
        author_locked: false,
        round: 1
    };
}

function section(id: string, text: string, origin: ChapterSection['origin'] = 'writer'): ChapterSection {
    return { id, text, origin };
}

describe('§4.4 chapterContent (D-7, T-2)', () => {
    it('joins the stored sections in order, blank line between them', () => {
        const chapter = chapterWith([
            section('section_1', 'Ilse measured the valley before the water did.'),
            section('section_2', 'The map she drew at nineteen was a map of a country that no longer exists.'),
            section('section_3', 'She signed the survey with a name the register no longer carried.')
        ]);

        // Sections are paragraphs and beats, so a single newline would fuse them into one block
        // for a reader — and for a judge answering C-7/C-8.
        expect(chapterContent(chapter)).toBe(
            'Ilse measured the valley before the water did.\n\n' +
                'The map she drew at nineteen was a map of a country that no longer exists.\n\n' +
                'She signed the survey with a name the register no longer carried.'
        );
    });

    it('an undrafted chapter reads as unwritten rather than as a blank line', () => {
        expect(chapterContent(chapterWith([]))).toBe('');
    });

    it('an Author-written span is prose in the string and still a proposal target in the record (P9, T-2)', () => {
        const chapter = chapterWith([
            section('section_1', 'The water took the church first.', 'author'),
            section('section_2', 'Nobody rang the bell after that.')
        ]);

        expect(chapterContent(chapter)).toBe('The water took the church first.\n\nNobody rang the bell after that.');

        // The derived string throws provenance away; the record keeps it, which is what lets the
        // server refuse a Writer's `editChapter` against the author-origin section (T-1a).
        expect(chapter.sections.map((entry) => entry.origin)).toEqual(['author', 'writer']);
    });

    it('is a pure read — the derived text is never written back into the record (P3)', () => {
        const chapter = chapterWith([section('section_1', 'One'), section('section_2', 'Two')]);
        const before = JSON.stringify(chapter);

        chapterContent(chapter);

        expect(JSON.stringify(chapter)).toBe(before);
    });
});
