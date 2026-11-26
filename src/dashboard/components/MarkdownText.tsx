import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/**
 * MarkdownText — the dashboard's ONE prose renderer, and the only place markdown settings live.
 *
 * WHY THIS EXISTS — the dashboard's prose surfaces are agent-authored. Phrase 1's summary, the
 * phrase-2 chapter entries, the revision bodies and the group rationale all reach the browser as
 * the markdown text the agent wrote, and before this component they were dropped into a `<div>` as
 * a string, so `## Premise` showed up on screen AS `## Premise` — the hash marks the agent means as
 * a heading were data, not presentation. Rendering the text as markdown is what turns the author's
 * intent into the document the user reads.
 *
 * WHY THE DEFAULTS ARE EXACTLY THESE:
 * - `remarkGfm` — the agents emit tables and task lists (a revision body comparing two drafts, the
 *   checklist the Summary phase keeps), and GFM is what makes those render instead of leaking `|`
 *   and `- [ ]` as characters.
 * - `remarkBreaks` — every single newline becomes a HARD break (`<br>`), which is load-bearing, not
 *   decoration. The producers emit LINE-ORIENTED text and rely on the newline surviving:
 *   `src/server/phrase/plotpoints.ts:chapterEntryContent` (70-78) joins one `Label: value` line per
 *   contract field with a SINGLE `\n` and no blank lines (its own comment says so), and the
 *   dashboard's `revisionBodyText` (`src/dashboard/components/story-contract.ts:2478-2483`) does the
 *   same for an object-shaped revision body — a node that was a literal `<pre>` before U-23, so
 *   newline-preserving by UA default. Markdown's own rule would fold each of those newlines into one
 *   soft break that an HTML block box prints as a single space, i.e.
 *   `Heading: … Must happen: … Must change: …` on one line. `pre-wrap` used to carry those breaks,
 *   and U-23 correctly took `pre-wrap` away from rendered markdown; this plugin is what replaces it.
 *   It works at the mdast level (fenced code, tables, headings, list items are all honoured), so no
 *   line-based parser is hand-rolled here.
 * - NO `rehype-raw` — deliberately absent, and it stays absent. Raw HTML in agent output remains
 *   escaped, so agent prose cannot inject markup into the single-user dashboard. `remark-breaks`
 *   cannot change that: it rewrites text nodes inside paragraphs, never html nodes.
 *
 * WHY THERE IS NO `skipHtml` EITHER — with no `rehype-raw`, react-markdown renders raw HTML as
 * plain text. `skipHtml` would DELETE it instead of showing it, which would silently drop content the
 * user asked us to keep visible, so the choice here is to leave it visible.
 *
 * The component takes a `className` so a surface can theme its own document (the panes keep their
 * layout rules) while the markdown itself is shared. `sv-markdown` — the stylesheet's one set of
 * typographic rules for rendered documents (`src/dashboard/styles/story.css`) — is ALWAYS on the
 * element, prepended to whatever `className` the surface adds, so no surface can forget it and no
 * surface can lose it.
 *
 * The wrapping element is a plain `<div>`. The prose it renders is a flow document (headings, lists,
 * tables) and a `<p>` wrapper would be invalid HTML around block content.
 */
export function MarkdownText({
    children,
    className,
    testId,
}: {
    children?: string;
    className?: string;
    testId?: string;
}) {
    // react-markdown treats a non-string child as nothing to render; normalising here keeps every
    // call site simple (they all pass `string | undefined` straight through from the payload).
    const text = typeof children === 'string' ? children : '';

    // `sv-markdown` first and always: the surface's own class is additive, never a replacement.
    const classes = className ? `sv-markdown ${className}` : 'sv-markdown';

    return (
        <div className={classes} data-testid={testId}>
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
        </div>
    );
}
