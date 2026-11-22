// The two blocks a thread is judged by are Markdown: the request is the brief the engine
// wrote (`# ROLE`, `## Criteria`, …) and the answer is the run's own report. Rendering them
// as preformatted text shows the source, not the meaning — headings, lists and inline code
// stay literal and every soft wrap becomes a line break. This renders them as prose instead,
// at the same reading scale the harness UI uses for model output.
//
// react-markdown escapes raw HTML (no rehype-raw), so model-authored text cannot inject
// markup, and `remark-gfm` adds the GitHub-flavoured constructs agents actually write:
// tables, task lists, strikethrough and fenced code.
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface MarkdownTextProps {
    /** The raw Markdown string to render. */
    children: string;
}

export function MarkdownText({ children }: MarkdownTextProps) {
    return (
        <div className="sv-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
        </div>
    );
}

export default MarkdownText;
