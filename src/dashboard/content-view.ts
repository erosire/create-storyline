// The center pane's document fold — the whole "what does this document look like"
// decision, as one pure function of three values the plugins own.
//
// WHY A SEPARATE MODULE: the fold is the most load-bearing logic in the center pane,
// and it must be testable without mounting React and without a plugin runtime. It also
// breaks what would otherwise be an import cycle: `plugins/content.ts` contributes the
// panel component, and the panel needs the fold, so both read it from here.
//
// THE RULES IT STATES:
//   • a store that never BOUND a collection, a collection with nothing in it, and a
//     body still loading are three different sentences — the pane never says "empty"
//     when the real answer is "this Title has no outlines collection yet";
//   • the chapter LIST carries no bodies (`content` is `getOnly`, harness
//     src/core/chapter.ts:49), so the list view points at the tree instead of passing
//     off a summary as the text, while one chapter's body comes from the tools' `get`;
//   • section bodies DO ride the snapshot, because `outlines`/`storyline` are defined
//     without `getOnly` (src/api/storyline.ts) — and a section whose read could not
//     carry the body says so, rather than rendering a phantom empty paragraph.
import { profileLabel, sortSections } from '../api';
import { CONTENT_LABELS, type ChapterDetail, type ChapterDetailState, type ContentKind, type ContentSelection, type StorylineRecords } from './contract';

/** One rendered block of the center pane: a heading, its text, and a short caption. */
export type ContentBlock = { heading: string; body: string; meta: string };

/** What the center pane renders for one selection — decided here, not in JSX. */
export type ContentView = {
    kind: ContentKind;
    title: string;
    blocks: readonly ContentBlock[];
    /** The sentence that explains an empty or unread document ('' when there is none). */
    notice: string;
};

/** A store that never bound a collection is a different answer than an empty one. */
const MISSING: Record<ContentKind, string> = {
    outlines: 'This Title has no outlines collection yet.',
    storyline: 'This Title has no storyline collection yet.',
    // Named by the document, not by the wire collection it folds (`chapters`), because this
    // sentence is read in the same pane whose tab and tree section say `Plotlines`.
    chapters: 'This Title binds no plotlines collection.',
    profiles: 'This Title binds no profiles collection.'
};

/** True when the snapshot named the collection at all (see `StorylineRecords`). */
function bound(records: StorylineRecords, kind: ContentKind): boolean {
    if (kind === 'outlines') return records.hasOutlines;
    if (kind === 'storyline') return records.hasStoryline;
    if (kind === 'chapters') return records.hasChapters;

    return records.hasProfiles;
}

/** The two section stores, rendered in the store's own order with their bodies. */
function sectionBlocks(records: StorylineRecords, kind: ContentKind): ContentBlock[] {
    return sortSections(kind === 'outlines' ? records.outlines : records.storyline).map((section, index) => ({
        heading: section.heading.length > 0 ? section.heading : '(untitled)',
        // `hasContent` is the honest flag: a `getOnly` body reads as absent, and a blank
        // paragraph must not be presented as though the story had been written and lost.
        body: section.hasContent ? section.content : '(body not carried by this read)',
        meta: section.order === null ? `${index + 1}` : `#${section.order}`
    }));
}

function chapterBlocks(records: StorylineRecords): ContentBlock[] {
    return records.chapters.map((chapter, index) => ({
        heading: chapter.title.length > 0 ? chapter.title : '(untitled)',
        // A chapter row carries a summary, never a body — see this file's header.
        body: chapter.summary,
        meta: `${index + 1} · ${chapter.status}`
    }));
}

function profileBlocks(records: StorylineRecords): ContentBlock[] {
    return records.profiles.map((profile) => ({
        // `profileLabel` is the api's own rule: the name plus `(F)`/`(M)` when a trait says so.
        heading: profileLabel(profile),
        body: profile.description,
        meta: profile.notes
    }));
}

/**
 * The whole center-pane decision. An unknown selection degrades to that document's
 * empty state instead of throwing, and every empty branch names its own reason.
 */
export function contentViewOf(records: StorylineRecords, selection: ContentSelection, detail: ChapterDetailState): ContentView {
    const kind = selection.kind;
    const title = CONTENT_LABELS[kind];

    // A chapter body is the only view that comes from a second read, so it is the one
    // branch that can be loading, failed, or answered with "that chapter is gone".
    if (kind === 'chapters' && selection.id.length > 0) {
        const chapter: ChapterDetail | null = detail.chapter;

        if (detail.phase === 'loading') return { kind, title, blocks: [], notice: 'Reading this chapter…' };
        if (detail.phase === 'error') return { kind, title, blocks: [], notice: detail.error };
        if (chapter === null) return { kind, title, blocks: [], notice: 'That chapter is no longer in the store.' };

        return {
            kind,
            title: chapter.title.length > 0 ? chapter.title : '(untitled)',
            // One block: the summary as the standfirst, the body as the text, the status as the caption.
            blocks: [{ heading: chapter.summary, body: chapter.content, meta: chapter.status }],
            notice: chapter.content.length === 0 ? 'This chapter has no body yet.' : ''
        };
    }

    const blocks = kind === 'chapters' ? chapterBlocks(records) : kind === 'profiles' ? profileBlocks(records) : sectionBlocks(records, kind);

    if (!bound(records, kind)) return { kind, title, blocks: [], notice: MISSING[kind] };
    if (blocks.length === 0) return { kind, title, blocks: [], notice: `No ${title.toLowerCase()} yet.` };
    // The chapter LIST carries no bodies, so the pane points at the tree instead of
    // pretending the summaries it has are the text.
    if (kind === 'chapters') return { kind, title, blocks, notice: 'Pick a chapter in the tree to read its body.' };

    return { kind, title, blocks, notice: '' };
}
