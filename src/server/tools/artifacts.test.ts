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
import { Store } from '../store/store';
import { compareNewestFirst, revisionBody, revisionBodyFields, revisionBodySections, revisionRows } from './artifacts';

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

// ---------------------------------------------------------------------------
// The newest-first ordering the row readers promise (D-3d/D-21/D-38a/D-17d)
// ---------------------------------------------------------------------------

/**
 * PHASE ① WRITES A WHOLE FAN-OUT INSIDE ONE SWEEP, so eleven drafts of one unit can carry the SAME
 * `created_at` down to the millisecond. `created_at` desc then needs a tie-break, and a §4 row carries
 * no ordering field — `rev` is the CAS token — so the ONLY creation signal is the id the store minted
 * (`store/store.ts:Collection.create` counts `<singular>_<n>`, ZERO-BASED and monotonic).
 *
 * Why it lives in this file: `artifacts.ts` is the one place the newest-first contract of the
 * ideas/revisions/verdicts/findings readers is written down, and a tie cannot be produced through the
 * store on purpose (the store stamps `created_at` itself and a caller cannot set it), so the comparator
 * is the deterministic unit under test. The eleven ids cross 10 on purpose: BELOW 10 a lexical tie-break
 * and a numeric one agree, which is exactly why the defect survived — every hand-written expectation in
 * the suite uses single-digit ids.
 */
describe('the newest-first ordering the row readers promise (D-3d, D-21, D-38a, D-17d)', () => {
    /** The one millisecond every row of a fan-out is stamped with. */
    const SAME_MS = '2026-11-24T09:00:00.000Z';

    /** A draft with only the fields the ordering reads. */
    const row = (id: string, created_at: string): Revision => ({ id, created_at }) as Revision;

    /** Eleven drafts, newest minted last: the order the readers owe a same-millisecond fan-out. */
    const NEWEST_FIRST = [
        'revision_10',
        'revision_9',
        'revision_8',
        'revision_7',
        'revision_6',
        'revision_5',
        'revision_4',
        'revision_3',
        'revision_2',
        'revision_1',
        'revision_0'
    ];

    it('breaks a same-millisecond tie by the minted id, so `revision_10` is the newest draft', () => {
        const rows = Array.from({ length: 11 }, (_, index) => row(`revision_${index}`, SAME_MS));

        // A bare `localeCompare` on the ids answers `revision_2` before `revision_10` — the OLDEST of the
        // eleven reported as the newest — which is the regression `mintedSuffix` exists to prevent.
        expect([...rows].sort(compareNewestFirst).map((draft) => draft.id)).toEqual(NEWEST_FIRST);
    });

    it('keeps `created_at` the first key: a bigger minted id never outranks a newer row', () => {
        // `revision_10` is the older write here, so the timestamp decides and the suffix must not.
        const rows = [row('revision_9', '2026-01-02T00:00:00.000Z'), row('revision_10', '2026-01-01T00:00:00.000Z')];

        expect([...rows].sort(compareNewestFirst).map((draft) => draft.id)).toEqual(['revision_9', 'revision_10']);
    });

    it('falls back to code units for an id the store did not mint, so the order is locale-independent', () => {
        // `revision_1a` has no numeric suffix, so `mintedSuffix` declines to answer and the pair is
        // ordered by UTF-16 CODE UNITS, descending. `localeCompare` is collation- and ICU-version
        // dependent, so the fallback cannot be one: the row order a Reader sees must not move with the
        // host's locale. A `revision_0`-vs-`revision_1a` pair is where a numeric-only comparator would
        // have thrown or guessed instead of answering deterministically.
        const rows = [row('revision_1a', SAME_MS), row('revision_0', SAME_MS), row('revision_2', SAME_MS)];

        expect([...rows].sort(compareNewestFirst).map((draft) => draft.id)).toEqual([
            'revision_2',
            'revision_1a',
            'revision_0'
        ]);
    });

    it('answers `revisionRows` newest-first across the tenth draft, not in insertion order', () => {
        // THE READER-LEVEL HALF. Eleven drafts written in one synchronous burst: whether the clock ticks
        // over inside the loop is irrelevant, because creation order, minted-suffix order and
        // `created_at` order all agree. So this pins the READER rather than racing the clock — and under
        // the shipped comparator, whose tie-break compared a row's id with ITSELF and therefore always
        // answered 0, the list came back in the store's insertion order: the OLDEST draft first.
        const store = Store.empty();
        const story = store.stories.create(
            {
                title: 'The Light Keeper',
                phase: 'summary',
                idea: 'A lighthouse keeper learns the light was never the point.',
                summary_locked: false,
                plotlines_locked: false,
                pending_kind: 'none',
                status: 'ready',
                trend: 'unknown',
                auto_approve: ['critical'],
                author_stop: false,
                digest_rev: 0,
                template_refs: [],
                chapter_deps: {}
            },
            { why: 'seed: story created' }
        );

        for (let index = 0; index < 11; index += 1) {
            store.revisions.create(
                {
                    story_id: story.id,
                    unit_kind: 'summary',
                    unit_ref: 'summary_0',
                    body: { fields: { premise: `draft ${index}` } },
                    state: 'drafted',
                    verdict_refs: []
                },
                { why: `seed: competing draft ${index}` }
            );
        }

        expect(revisionRows(store, story.id).map((draft) => draft.id)).toEqual(NEWEST_FIRST);
    });
});
