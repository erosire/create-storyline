/**
 * The §4.15 draft-body contract — the one place a unit kind and an open `body: unknown` column are
 * agreed (D-21/D-22/T-2a).
 *
 * This is pinned as its own file because the bug it guards is silent and expensive: `editChapter`
 * in a diverging Story files a chapter draft as `{sections: [...]}` (`writer.ts`, D-3d/D-21), and
 * `selectRevision` reads it back through these helpers (D-22's install, U-13's side-by-side read).
 * Wrapping the stored shape instead of unwrapping it makes `revisionBodySections` return `[]`, so a
 * selection would install an EMPTY chapter and delete the text it did not choose — a passing
 * `selectRevision` that destroyed the prose. Both shapes (the stored one and the older bare one)
 * are pinned in both directions so the install and the read can never disagree.
 */
import { describe, expect, it } from 'vitest';
import type { ChapterSection, Revision } from '../../shared/types';
import { revisionBody, revisionBodyFields, revisionBodySections } from './artifacts';

/** A stored draft row, with only the fields these two readers touch. */
function draft(unitKind: Revision['unit_kind'], body: unknown): Revision {
    return { id: 'revision_1', unit_kind: unitKind, unit_ref: 'chapter_1', body, state: 'competing' } as Revision;
}

describe('the §4.15 draft-body contract (D-21, D-22)', () => {
    it('reads the shape editChapter files: a chapter body of {sections}', () => {
        // Exactly what `fileRevision` writes for a diverging prose write (writer.ts:587).
        const sections: ChapterSection[] = [
            { id: 'section_1', text: 'The bell under the water.', origin: 'writer' },
            { id: 'section_2', text: 'The Author keeps this line.', origin: 'author' }
        ];

        // The mapping normalises each section for storage: an origin defaults to `writer`, and the
        // provenance fields are always present (`last_run_ref: null` until a run touches it).
        expect(revisionBodySections(draft('chapter', { sections }))).toEqual([
            {
                id: 'section_1',
                text: 'The bell under the water.',
                origin: 'writer',
                last_run_ref: null,
                last_why: undefined
            },
            {
                id: 'section_2',
                text: 'The Author keeps this line.',
                origin: 'author',
                last_run_ref: null,
                last_why: undefined
            }
        ]);
        // The install path reads the same helper, so the unit gets the winning text, not `[]`.
        expect(revisionBodySections(draft('chapter', { sections })).map((section) => section.text)).toEqual([
            'The bell under the water.',
            'The Author keeps this line.'
        ]);
    });

    it('accepts a bare section array as the older shape, and mints the ids it lacks', () => {
        expect(revisionBodySections(draft('chapter', [{ text: 'Loose prose.' }]))).toEqual([
            { id: 'section_1', text: 'Loose prose.', origin: 'writer', last_run_ref: null, last_why: undefined }
        ]);
    });

    it('yields no sections for a body that holds no prose', () => {
        expect(revisionBodySections(draft('chapter', 'A draft that stored bare prose.'))).toEqual([]);
        expect(revisionBodySections(draft('chapter', null))).toEqual([]);
        // A contract-shaped draft asked for prose: the fields are not sections.
        expect(revisionBodySections(draft('chapter', { fields: { premise: 'A keeper, a light.' } }))).toEqual([]);
    });

    it('reads a Summary or plotline draft as fields, stored or bare', () => {
        expect(
            revisionBodyFields(
                draft('plotline', { fields: { heading: 'The tower', must_happen: 'He climbs.', order: 2, noise: {} } })
            )
        ).toEqual({ heading: 'The tower', must_happen: 'He climbs.', order: 2 });
        expect(revisionBodyFields(draft('summary', { premise: 'A keeper, a light.', tone: 'elegiac' }))).toEqual({
            premise: 'A keeper, a light.',
            tone: 'elegiac'
        });
        // §4.15's open column can hold anything; only strings and finite numbers install (T-11's
        // job is the call, this is the read of what is already stored).
        expect(revisionBodyFields(draft('summary', { premise: 'x', words: NaN, note: null }))).toEqual({
            premise: 'x'
        });
        expect(revisionBodyFields(draft('summary', null))).toEqual({});
    });

    it('normalises the stored wrapper rather than double-wrapping it', () => {
        // The old behaviour: `{ sections: [...] }` became `{ sections: { sections: [...] } }`, so the
        // install read a non-array and wrote an empty chapter.
        expect(revisionBody('chapter', { sections: [{ text: 'x' }] })).toEqual({ sections: [{ text: 'x' }] });
        expect(revisionBody('chapter', [{ text: 'x' }])).toEqual({ sections: [{ text: 'x' }] });
        expect(revisionBody('chapter', 'prose')).toEqual({ sections: [] });
        expect(revisionBody('plotline', { fields: { heading: 'h' } })).toEqual({ fields: { heading: 'h' } });
        expect(revisionBody('summary', { premise: 'p' })).toEqual({ fields: { premise: 'p' } });
        expect(revisionBody('summary', null)).toEqual({ fields: {} });
    });
});
