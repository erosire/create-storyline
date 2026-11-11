// §4.4 — the one derived read over chapter prose.
//
// WHY THIS FILE EXISTS AND LIVES IN `shared`: D-7 stores chapter prose as ordered
// `sections` (so a reviewer can change one paragraph without rewriting the chapter, and so
// T-2 can mark Author-written spans at section granularity), while §4.4 still names a
// `content` string for readers of the model. Rather than store both and risk two sources of
// truth (P3), the string is DERIVED here. It lives in `shared` rather than beside the store
// because the dashboard (W9-W13) renders chapter prose in the browser and must not pull
// `node:fs` into the bundle by importing a store module for one join.
import type { Chapter } from './types';

/**
 * The §4.4 `content` of a chapter, joined from its stored sections in order.
 *
 * Separator is a blank line: sections are paragraphs/beats, and joining them with a single
 * newline would fuse them into one block for a reader (and for a judge answering C-7/C-8).
 * An empty chapter is the empty string, not a blank line — a chapter that has not been
 * drafted reads as unwritten.
 */
export function chapterContent(chapter: Chapter): string {
    return chapter.sections.map((section) => section.text).join('\n\n');
}
