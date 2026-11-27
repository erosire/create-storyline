// U-4 / C-14 — the Seed card, and it is a KEPT SURFACE RATHER THAN A MOUNTED ONE. Nothing renders it today: the
// content area shows one pane at a time (U-4), and the Seed reaches the Author through the rail — U-25 put a Seed
// row under EVERY phrase, opening `story-folders.tsx`'s `SeedPane` for Phrase ① and `PhraseSeedPane` for Phrase ②.
// The card stays in the tree, and pinned by its own suite, because it is the one component that states the C-14
// promise in markup: the Seed is the thing the book is measured against, so the Summary being judged and the Seed
// it is judged by belong on the same screen. If a later surface wants a Seed that sits beside the artifact instead
// of opening as a pane, this is it — and the `position: sticky` rule that made it "never scroll away" is still in
// `styles/story.css` (`.sv-seed`), which is the styling a remount would get for free.
//
// D-3b: `chapter_count` rides on this card because it is the same kind of Author truth —
// declared, never chosen by the Writer, and a hard fact (a deviation is a failing C-0).
import type { Summary } from '../../types';

export interface SeedCardProps {
    idea: string;
    title: string;
    summary?: Summary | null;
}

export function SeedCard({ idea, title, summary }: SeedCardProps) {
    return (
        <section className="sv-seed" aria-label="Seed">
            <header className="sv-seed-head">
                <h2 className="sv-seed-title">Seed — {title}</h2>
                {/* P5: the one sentence the Author must never have to re-read in a changelog. */}
                <span className="sv-seed-note">
                    Author-written · read-only for every agent, every phase, forever (P5)
                </span>
            </header>

            {/* `whitespace-pre-wrap` keeps the Author's own line breaks: the Seed is prose, not a field. */}
            <p className="sv-seed-body">{idea}</p>

            <footer className="sv-seed-measure">
                {/* C-0 / D-3b: the measure of the book, stated next to the thing it expands. */}
                The book&apos;s measure: {summary ? summary.chapter_count : 'no'} chapter
                {summary?.chapter_count === 1 ? '' : 's'} — C-0 fails on any other count (D-3b)
                {summary ? '' : ' · the Summary record has not been written yet'}
            </footer>
        </section>
    );
}
