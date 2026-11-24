// R2 / U3 — the word diff between a group's latest revision and the one it replaced.
//
// WHY THIS EXISTS: the group pane used to print the current text as one undifferentiated paragraph. The
// Author could see that a revision existed (and how many were archived) but not WHAT the Writer changed —
// the one thing a revision number is for. The pane now renders the latest text against its immediate
// predecessor: removed words in `<del>` (struck through, red), added words in `<ins>` (green).
//
// WHY A WORD DIFF, AND WHY DELETIONS ARE GROUPED. A sentence-level diff marked the WHOLE changed sentence on
// both sides, which hid which words had actually moved — the Author could no longer tell removed text from
// kept text. A plain word diff is exact, but it fragments a rewritten clause into alternating single-word
// spans. So the comparison is still word-by-word, and each contiguous change run is collapsed before it is
// rendered: all removed words in the run are struck together, then all added words are printed together.
// Unchanged words — `the`, `it`, `and` — stay plain between runs, which is what makes the kept text legible.
//
// ONLY ONE COMPARISON, AND ONLY PROSE THAT IS ALREADY ON THE WIRE. `PhraseGroupRow.previous_content` is
// the text of the revision immediately before the latest one; the rest of the archived history stays
// server-side (R2's metadata-only history), so this component can never offer a diff the projection did
// not send. When a group is at revision 1 there is nothing to compare, and the pane prints the text plain.
//
// Tokens keep their trailing whitespace, so joining them reproduces the source exactly and the paragraph
// spacing of the current text survives (`white-space: pre-wrap` on the prose rule).
import { Fragment } from 'react';

export type DiffSegmentKind = 'same' | 'removed' | 'added';

export interface DiffSegment {
    kind: DiffSegmentKind;
    text: string;
}

/**
 * The LCS table is bounded rather than unbounded: a Summary group is prose, not a manuscript, so a diff
 * this large is outside the surface's contract. Falling back to "all removed, all added" is still honest
 * (nothing is silently dropped) and keeps a pathological paste from freezing the pane.
 */
const MAX_LCS_CELLS = 1_000_000;

/** A word with the whitespace that follows it, so a run of changed words keeps its spaces when joined. */
const TOKEN = /\s*\S+\s*/g;

function tokensOf(text: string): string[] {
    return text.match(TOKEN) ?? [];
}

function merge(segments: DiffSegment[]): DiffSegment[] {
    const merged: DiffSegment[] = [];

    for (const segment of segments) {
        const last = merged[merged.length - 1];

        if (last !== undefined && last.kind === segment.kind) {
            last.text += segment.text;
        } else {
            merged.push({ ...segment });
        }
    }

    return merged;
}

/** The shortest edit script over two token lists, as `same` / `removed` / `added` runs. */
function diffTokens(before: readonly string[], after: readonly string[]): DiffSegment[] {
    const n = before.length;
    const m = after.length;

    if (n === 0) return m === 0 ? [] : [{ kind: 'added', text: after.join('') }];
    if (m === 0) return [{ kind: 'removed', text: before.join('') }];

    if (n * m > MAX_LCS_CELLS) {
        return [
            { kind: 'removed', text: before.join('') },
            { kind: 'added', text: after.join('') }
        ];
    }

    // `table[i * width + j]` is the LCS length of `before[i..]` and `after[j..]`.
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);

    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            table[i * width + j] =
                before[i] === after[j]
                    ? (table[(i + 1) * width + j + 1] ?? 0) + 1
                    : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
        }
    }

    const segments: DiffSegment[] = [];
    let i = 0;
    let j = 0;

    while (i < n && j < m) {
        const tokenBefore = before[i] ?? '';
        const tokenAfter = after[j] ?? '';

        if (tokenBefore === tokenAfter) {
            segments.push({ kind: 'same', text: tokenBefore });
            i += 1;
            j += 1;
        } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
            segments.push({ kind: 'removed', text: tokenBefore });
            i += 1;
        } else {
            segments.push({ kind: 'added', text: tokenAfter });
            j += 1;
        }
    }

    while (i < n) {
        segments.push({ kind: 'removed', text: before[i] ?? '' });
        i += 1;
    }

    while (j < m) {
        segments.push({ kind: 'added', text: after[j] ?? '' });
        j += 1;
    }

    return segments;
}

/**
 * Collapse each contiguous change run (removed/added segments with no unchanged token between them) into
 * ONE removal block followed by ONE addition block. This is the reported fix: a rewritten clause no longer
 * renders as a word grid of alternating red and green spans, while the unchanged words around it stay
 * unmarked so the Author can still see exactly what was kept.
 */
function groupChangeRuns(segments: readonly DiffSegment[]): DiffSegment[] {
    const grouped: DiffSegment[] = [];
    let index = 0;

    while (index < segments.length) {
        const segment = segments[index];

        if (segment === undefined) break;

        if (segment.kind === 'same') {
            grouped.push(segment);
            index += 1;
            continue;
        }

        let removed = '';
        let added = '';

        while (index < segments.length && segments[index]?.kind !== 'same') {
            const change = segments[index];

            if (change !== undefined) {
                if (change.kind === 'removed') removed += change.text;
                else added += change.text;
            }

            index += 1;
        }

        if (removed !== '') grouped.push({ kind: 'removed', text: removed });
        if (added !== '') grouped.push({ kind: 'added', text: added });
    }

    return grouped;
}

/**
 * The diff between a group's previous revision and its current one, as display runs.
 *
 * The unchanged head and tail are trimmed before the LCS so the common case — one word edited inside a
 * paragraph — stays small no matter how long the surrounding prose is. The two streams are reconstructed
 * exactly: concatenating `same` + `removed` (in order) gives `previous`, and `same` + `added` gives
 * `current`.
 */
export function diffRevisions(previous: string, current: string): DiffSegment[] {
    const before = tokensOf(previous);
    const after = tokensOf(current);

    let start = 0;

    while (start < before.length && start < after.length && before[start] === after[start]) start += 1;

    let beforeEnd = before.length;
    let afterEnd = after.length;

    while (
        beforeEnd > start &&
        afterEnd > start &&
        before[beforeEnd - 1] === after[afterEnd - 1]
    ) {
        beforeEnd -= 1;
        afterEnd -= 1;
    }

    return groupChangeRuns(
        merge([
            ...before.slice(0, start).map((text): DiffSegment => ({ kind: 'same', text })),
            ...diffTokens(before.slice(start, beforeEnd), after.slice(start, afterEnd)),
            ...before.slice(beforeEnd).map((text): DiffSegment => ({ kind: 'same', text }))
        ])
    );
}

export interface RevisionDiffProps {
    /** The revision immediately before the current one. */
    previous: string;
    /** The current revision's text. */
    current: string;
}

/**
 * Renders the latest revision against its predecessor: removed words struck red, added words green.
 * A changed run renders as one struck block then one green block; unchanged words stay plain.
 */
export function RevisionDiff({ previous, current }: RevisionDiffProps) {
    const segments = diffRevisions(previous, current);

    return (
        <>
            {segments.map((segment, index) => {
                const before = segments[index - 1];
                // A replacement is two runs side by side. Put one boundary between them when the prose did
                // not carry one, so the Author — and a screen reader — reads two words, not `oneshe`.
                const boundary =
                    before !== undefined &&
                    before.kind !== 'same' &&
                    segment.kind !== 'same' &&
                    !/\s$/.test(before.text) &&
                    !/^\s/.test(segment.text);

                const node =
                    segment.kind === 'removed' ? (
                        <del>{segment.text}</del>
                    ) : segment.kind === 'added' ? (
                        <ins>{segment.text}</ins>
                    ) : (
                        <Fragment>{segment.text}</Fragment>
                    );

                return (
                    <Fragment key={index}>
                        {boundary ? ' ' : null}
                        {node}
                    </Fragment>
                );
            })}
        </>
    );
}

export default RevisionDiff;
