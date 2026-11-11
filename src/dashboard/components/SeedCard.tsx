// U-4 / C-14 — the Seed card. It is pinned and read-only on every Story view for every viewer,
// because it is the thing the book is measured against: C-14 asks whether the Summary delivers
// the Seed, so the Seed has to be on screen while the Summary is being judged. It never scrolls
// away (the pane is `position: sticky` in `styles/story.css`).
//
// D-3b: `chapter_count` rides on this card because it is the same kind of Author truth —
// declared, never chosen by the Writer, and a hard fact (a deviation is a failing C-0).
import type { Summary } from '../../shared/types';

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
