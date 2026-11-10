// The center pane's document fold, asserted as data.
//
// WHY THIS FILE EXISTS: `contentViewOf` is the whole "what does this document look like"
// decision (src/dashboard/content-view.ts), and every branch of it is a sentence an
// operator reads. The three empty states are DIFFERENT facts — a collection this Title
// never bound, a collection with nothing in it, and a chapter body still arriving — and a
// fold that collapses them tells the operator the story is empty when the real answer is
// that the tools are missing. Each branch is asserted whole with `toEqual`, so a merged
// sentence or a dropped caption fails here rather than in the browser.
import { describe, expect, it } from 'vitest';
import type { ChapterDetailState, ContentSelection } from './contract';
import { contentViewOf } from './content-view';
import { CHAPTER_BODY, RECORDS } from './testing/doubles';

/** The selection for one document, whole (`id: ''`) or pointing at one chapter. */
const selectionFor = (kind: ContentSelection['kind'], id = ''): ContentSelection => ({ kind, id });

/** No chapter selected, so the chapter-body branch is out of play. */
const NO_DETAIL: ChapterDetailState = { chapter: null, phase: 'idle', error: '' };

describe('content view fold', () => {
    it('renders the outlines document from the snapshot, in the store order with its bodies', () => {
        expect(contentViewOf(RECORDS, selectionFor('outlines'), NO_DETAIL)).toEqual({
            kind: 'outlines',
            title: 'Outlines',
            blocks: [{ heading: 'Opening', body: 'Fog, then a harbour.', meta: '#1' }],
            notice: ''
        });
    });

    it('numbers a section that has no order by its position instead of pretending it has one', () => {
        const records = { ...RECORDS, outlines: [{ ...RECORDS.outlines[0], order: null, heading: '' }] };

        expect(contentViewOf(records, selectionFor('outlines'), NO_DETAIL).blocks).toEqual([
            { heading: '(untitled)', body: 'Fog, then a harbour.', meta: '1' }
        ]);
    });

    it('says a body the read could not carry instead of rendering a phantom empty section', () => {
        // `hasContent: false` is what a `getOnly` section body reads as (src/api/storyline.ts
        // `sectionFromEntry`); "the section is empty" and "this read has no bodies" are
        // different facts and only the second one is true here.
        const records = { ...RECORDS, storyline: [{ ...RECORDS.storyline[0], hasContent: false, content: '' }] };

        expect(contentViewOf(records, selectionFor('storyline'), NO_DETAIL)).toEqual({
            kind: 'storyline',
            title: 'Storyline',
            blocks: [{ heading: 'Chapter one', body: '(body not carried by this read)', meta: '#1' }],
            notice: ''
        });
    });

    it('lists chapters with their summaries, and points at the tree for the bodies', () => {
        expect(contentViewOf(RECORDS, selectionFor('chapters'), NO_DETAIL)).toEqual({
            kind: 'chapters',
            title: 'Plotlines',
            blocks: [{ heading: 'The crossing', body: 'The cartographer sails', meta: '1 · draft' }],
            notice: 'Pick a chapter in the tree to read its body.'
        });
    });

    it('labels a profile with the gender its traits carry, which is what the tree shows too', () => {
        expect(contentViewOf(RECORDS, selectionFor('profiles'), NO_DETAIL)).toEqual({
            kind: 'profiles',
            title: 'Profiles',
            blocks: [{ heading: 'Ada (F)', body: 'Cartographer', meta: 'leads' }],
            notice: ''
        });

        // No gender trait, no suffix — the fold reuses the api's one rule rather than
        // inventing a second.
        const records = { ...RECORDS, profiles: [{ ...RECORDS.profiles[0], traits: ['proud'] }] };

        expect(contentViewOf(records, selectionFor('profiles'), NO_DETAIL).blocks[0].heading).toBe('Ada');
    });

    it('shows one chapter body as the text, with the summary as the standfirst', () => {
        const detail: ChapterDetailState = { chapter: CHAPTER_BODY, phase: 'ready', error: '' };

        expect(contentViewOf(RECORDS, selectionFor('chapters', 'ch-1'), detail)).toEqual({
            kind: 'chapters',
            title: 'The crossing',
            blocks: [{ heading: 'The cartographer sails', body: 'She counted the buoys twice.', meta: 'draft' }],
            notice: ''
        });

        // A body that really is empty gets its own sentence — the read DID carry one.
        const blank: ChapterDetailState = { ...detail, chapter: { ...CHAPTER_BODY, content: '', title: '' } };

        expect(contentViewOf(RECORDS, selectionFor('chapters', 'ch-1'), blank)).toEqual({
            kind: 'chapters',
            title: '(untitled)',
            blocks: [{ heading: 'The cartographer sails', body: '', meta: 'draft' }],
            notice: 'This chapter has no body yet.'
        });
    });

    it('names which chapter-body state it is in, rather than showing the list under a selected chapter', () => {
        const selection = selectionFor('chapters', 'ch-1');

        expect(contentViewOf(RECORDS, selection, { chapter: null, phase: 'loading', error: '' })).toEqual({
            kind: 'chapters',
            title: 'Plotlines',
            blocks: [],
            notice: 'Reading this chapter…'
        });
        expect(contentViewOf(RECORDS, selection, { chapter: null, phase: 'error', error: 'chapters get: no such record' })).toEqual({
            kind: 'chapters',
            title: 'Plotlines',
            blocks: [],
            notice: 'chapters get: no such record'
        });
        expect(contentViewOf(RECORDS, selection, { chapter: null, phase: 'ready', error: '' })).toEqual({
            kind: 'chapters',
            title: 'Plotlines',
            blocks: [],
            notice: 'That chapter is no longer in the store.'
        });
    });

    it('keeps an unbound collection, an empty collection, and an unread store three sentences apart', () => {
        // Nothing bound: the tools are missing, and that is not the same news as "no rows".
        expect(contentViewOf(RECORDS, selectionFor('outlines'), NO_DETAIL).notice).toBe('');
        expect(contentViewOf({ ...RECORDS, hasOutlines: false }, selectionFor('outlines'), NO_DETAIL)).toEqual({
            kind: 'outlines',
            title: 'Outlines',
            blocks: [],
            notice: 'This Title has no outlines collection yet.'
        });
        // Bound and empty: the story just has not been written here. The sentence is the
        // document's own name lower-cased (`CONTENT_LABELS.chapters` is 'Plotlines'), so the
        // center pane never calls the same thing two things.
        expect(contentViewOf({ ...RECORDS, chapters: [] }, selectionFor('chapters'), NO_DETAIL)).toEqual({
            kind: 'chapters',
            title: 'Plotlines',
            blocks: [],
            notice: 'No plotlines yet.'
        });
        // The third state, spelled out because it is the one an operator can fix: the Title was
        // created without the chapters tool, which is not the same news as an empty document.
        expect(contentViewOf({ ...RECORDS, hasChapters: false, chapters: [] }, selectionFor('chapters'), NO_DETAIL)).toEqual({
            kind: 'chapters',
            title: 'Plotlines',
            blocks: [],
            notice: 'This Title binds no plotlines collection.'
        });
        expect(contentViewOf({ ...RECORDS, hasProfiles: false, profiles: [] }, selectionFor('profiles'), NO_DETAIL).notice).toBe(
            'This Title binds no profiles collection.',
        );
    });

    it('ignores a selection id for a document that has no per-row view', () => {
        // Only a chapter body needs a second read; an outline row is already in the
        // snapshot, so selecting it shows the whole document rather than a blank branch.
        expect(contentViewOf(RECORDS, selectionFor('outlines', 'o-1'), NO_DETAIL)).toEqual(
            contentViewOf(RECORDS, selectionFor('outlines'), NO_DETAIL),
        );
        expect(contentViewOf(RECORDS, selectionFor('storyline', 's-1'), NO_DETAIL).blocks).toEqual([
            { heading: 'Chapter one', body: 'She woke before dawn.', meta: '#1' }
        ]);
    });
});
