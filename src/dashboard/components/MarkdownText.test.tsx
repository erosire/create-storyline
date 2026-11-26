// MarkdownText — the shared Markdown renderer, pinned on its own so the panes that use it can be pinned on
// what they PASS rather than on what react-markdown emits.
//
// What is under test here is the component's own contract, and every expectation below is derived from the
// input string by reading it, not from a render of the pane:
//   1. the block structure (`## x` is an `<h2>`, `- x` is an `<li>`, a GFM table is a `<table>`);
//   2. the two backward-compatible hooks — `className` APPENDS to `sv-markdown` (never replaces it), and
//      `testId` writes `data-testid` on the SAME wrapper and omits the attribute entirely when absent, so a
//      pane's existing `queryByTestId(...) === null` assertion stays an assertion;
//   3. the security property the file's header promises: raw HTML stays ESCAPED (no `rehype-raw`), so model-
//      or Author-authored text cannot inject markup;
//   4. the line breaks the WRITER installed (`remark-breaks`) — asserted against the payloads the producers
//      really store, imported from the producer modules below rather than retyped here, because the whole point
//      is that a single `\n` in that text has to survive.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MarkdownText } from './MarkdownText';
import { revisionBodyText } from './story-contract';
import { chapterEntryContent } from '../../server/phrase/plotpoints';
import { composePhraseContent } from '../../shared/phrase';
import type { PhraseGroup } from '../../shared/types';

/** The shape `shared/phrase.ts:composePhraseContent` actually produces: a heading per group, prose under it. */
const OVERVIEW = [
    '## Premise',
    'A keeper of a lighthouse begins lying to the sea.',
    '',
    '## Promise',
    'A sealed cathedral of data, salt in every image.'
].join('\n');

/** Every block MarkdownText emitted, in DOM order, as `TAG:text` — one exact string per block. */
function blocks(root: ParentNode): string[] {
    return Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol,table,pre,blockquote,hr')).map(
        (block) => {
            if (block.tagName === 'UL' || block.tagName === 'OL') {
                // A list's own textContent joins items without separators, which hides a dropped item; the
                // items are listed instead, so `- a` / `- b` is one entry each.
                return `UL:${Array.from(block.querySelectorAll('li')).map((item) => item.textContent).join('|')}`;
            }

            return `${block.tagName}:${block.textContent ?? ''}`;
        }
    );
}

describe('MarkdownText — the Markdown source becomes prose, not the other way round', () => {
    it('renders a `## <title>` block as a real heading over its prose, in source order', () => {
        const { container } = render(<MarkdownText>{OVERVIEW}</MarkdownText>);
        const wrapper = container.querySelector('.sv-markdown') as HTMLElement;

        expect(blocks(wrapper)).toEqual([
            'H2:Premise',
            'P:A keeper of a lighthouse begins lying to the sea.',
            'H2:Promise',
            'P:A sealed cathedral of data, salt in every image.'
        ]);
        // The marker a reader must no longer see.
        expect(wrapper.textContent).not.toContain('## ');
        // And the exact text the wrapper holds, which documents the OTHER half of the fix. The `\n` between
        // the blocks is not paragraphing: react-markdown writes a newline TEXT NODE between sibling blocks
        // (`<h2>Premise</h2>\n<p>…</p>\n<h2>Promise</h2>\n<p>…</p>`). Under `.sv-summary-text`'s
        // `white-space: pre-wrap` every one of those printed as a real line break — a heading pushed a line
        // off its own body, and a blank line between groups — which is the vertical gap the user reported.
        // `.sv-summary-text.sv-markdown { white-space: normal }` (`styles/story.css`) is what collapses them.
        expect(wrapper.textContent).toBe(
            'Premise\nA keeper of a lighthouse begins lying to the sea.\n' +
                'Promise\nA sealed cathedral of data, salt in every image.'
        );
    });

    it('renders the GFM constructs an agent writes: list, table, task list, fenced code', () => {
        const { container } = render(
            <MarkdownText>
                {'## Criteria\n\n- a\n- b\n\n| Group | Score |\n| --- | --- |\n| Premise | 79 |\n\n- [x] passed\n\n```ts\nconst ok = true;\n```\n'}
            </MarkdownText>
        );
        const wrapper = container.querySelector('.sv-markdown') as HTMLElement;

        expect(wrapper.querySelector('h2')?.textContent).toBe('Criteria');
        // The exact items. The second list's leading space is the gap after the `<input>` the checkbox is —
        // it is in the markup (`<input …/> passed`), so it is asserted rather than trimmed away.
        expect(
            Array.from(wrapper.querySelectorAll('ul')!).map((list) =>
                Array.from(list.querySelectorAll('li')).map((item) => item.textContent)
            )
        ).toEqual([
            ['a', 'b'],
            [' passed']
        ]);
        expect(wrapper.querySelector('thead th')?.textContent).toBe('Group');
        expect(Array.from(wrapper.querySelectorAll('tbody td')!).map((cell) => cell.textContent)).toEqual([
            'Premise',
            '79'
        ]);
        // A task list carries a real checkbox, and the checked state is the mark, not a literal `[x]`.
        const task = wrapper.querySelector('input[type="checkbox"]') as HTMLInputElement | null;

        expect(task?.checked).toBe(true);
        expect(wrapper.textContent).not.toContain('[x]');
        expect(wrapper.querySelector('pre code')?.textContent).toContain('const ok = true;');
    });

    it('escapes raw HTML instead of trusting it (no rehype-raw)', () => {
        const { container } = render(
            <MarkdownText>{'A model wrote <img src=x onerror="boom()"> and <script>alert(1)</script>.'}</MarkdownText>
        );
        const wrapper = container.querySelector('.sv-markdown') as HTMLElement;

        // No element was injected — the text is still there, as text.
        expect(wrapper.querySelector('img')).toBeNull();
        expect(wrapper.querySelector('script')).toBeNull();
        expect(wrapper.querySelector('p')?.textContent).toBe(
            'A model wrote <img src=x onerror="boom()"> and <script>alert(1)</script>.'
        );
    });

    it('renders an empty string as an empty wrapper, so a pane keeps its own empty branch', () => {
        const { container } = render(<MarkdownText testId="summary-text">{''}</MarkdownText>);
        const wrapper = screen.getByTestId('summary-text');

        expect(wrapper.children).toHaveLength(0);
        expect(wrapper.textContent).toBe('');
    });
});

/**
 * The lines a node RENDERS, in order — the assertion `white-space: normal` makes impossible to fake, because
 * under it a flattened payload and a line-by-line payload have the SAME `textContent` and only this structure
 * tells them apart. A line closes at a `<br>` (the break the writer wrote) and at every BLOCK boundary (a block
 * box starts its own line, which is what a heading, a paragraph, a list item or a table cell does), and empty
 * lines are dropped — the `\n` react-markdown writes between block siblings is not a line the author wrote.
 * A `<pre>` contributes ONE line holding the code exactly, because the newlines inside a fence are the code's
 * text rather than rendered line breaks.
 */
function renderedLines(root: ParentNode): string[] {
    const BLOCK = new Set([
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE',
        'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'DIV'
    ]);
    const lines: string[] = [];
    let current = '';
    const close = () => {
        lines.push(current.trim());
        current = '';
    };

    const walk = (node: Node) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 3) {
                current += child.textContent ?? '';
            } else if ((child as Element).tagName === 'BR') {
                close();
            } else if (BLOCK.has((child as Element).tagName)) {
                close();
                walk(child);
                close();
            } else {
                walk(child);
            }
        }
    };

    walk(root);
    close();

    return lines.filter((line) => line !== '');
}

/** One chapter entry's plotpoints, as §4.3 records them — the input `chapterEntryContent` composes from. */
const CHAPTER_FIELDS = {
    heading: 'The Salt Road',
    must_happen: 'the crossing is attempted',
    must_change: 'Wren loses the map',
    pov: 'Wren',
    setups: 'the bridge is burned',
    payoffs: 'the gate is reached'
};

describe('MarkdownText — every line break the writer installed survives rendering', () => {
    it('puts one line on the page per `Label: value` line of a real chapter entry (`chapterEntryContent`)', () => {
        // THE PRODUCER'S OWN BYTES, not a re-typed fixture: `server/phrase/plotpoints.ts:70-78` joins one
        // `Label: value` line per field with a SINGLE `\n` and no blank lines, so there is nothing here for
        // markdown to paragraph on. Before `remark-breaks` this rendered as ONE `<p>` with no break at all and
        // the six labelled fields read as one sentence — the text was intact and unreadable.
        const content = chapterEntryContent({ id: 'chapter_1', key: 'chapter_1' } as unknown as PhraseGroup, CHAPTER_FIELDS);

        expect(content).toBe(
            'Heading: The Salt Road\n' +
                'Must happen: the crossing is attempted\n' +
                'Must change: Wren loses the map\n' +
                'POV: Wren\n' +
                'Setups: the bridge is burned\n' +
                'Payoffs: the gate is reached'
        );

        const { container } = render(<MarkdownText>{content}</MarkdownText>);
        const wrapper = container.querySelector('.sv-markdown') as HTMLElement;

        // One paragraph box — markdown has no reason to invent six, and a `<ul>` here would be a list the
        // writer never wrote — with one break between each pair of the writer's lines.
        expect(wrapper.querySelectorAll('p')).toHaveLength(1);
        expect(wrapper.querySelectorAll('ul,ol,li,h1,h2,h3,h4,h5,h6')).toHaveLength(0);
        expect(wrapper.querySelectorAll('br')).toHaveLength(5);
        expect(renderedLines(wrapper)).toEqual([
            'Heading: The Salt Road',
            'Must happen: the crossing is attempted',
            'Must change: Wren loses the map',
            'POV: Wren',
            'Setups: the bridge is burned',
            'Payoffs: the gate is reached'
        ]);
    });

    it('keeps the lines of a line-oriented draft body apart (`revisionBodyText` over an object body)', () => {
        // A §4.15 revision body may BE the prose fields (§4.15 `body` is `unknown`), and
        // `story-contract.ts:revisionBodyText`'s object branch then emits `key: value` joined with ONE `\n`.
        // That node used to be a literal `<pre>` — newline-preserving by UA default — so the breaks are the
        // guarantee this renderer has to carry now, not one the element used to carry.
        const body = { premise: 'The index answered first.', promise: 'The city remembers salt.', ending: 'The gate stays shut.' };

        expect(revisionBodyText(body)).toBe(
            'premise: The index answered first.\npromise: The city remembers salt.\nending: The gate stays shut.'
        );

        const { container } = render(<MarkdownText>{revisionBodyText(body)}</MarkdownText>);
        const wrapper = container.querySelector('.sv-markdown') as HTMLElement;

        expect(wrapper.querySelectorAll('p')).toHaveLength(1);
        expect(wrapper.querySelectorAll('br')).toHaveLength(2);
        expect(renderedLines(wrapper)).toEqual([
            'premise: The index answered first.',
            'promise: The city remembers salt.',
            'ending: The gate stays shut.'
        ]);
    });

    it('renders a heading per entry of the real composed phrase text, and the writer’s lines inside each entry', () => {
        // BOTH PRODUCERS AT ONCE: `shared/phrase.ts:composePhraseContent` puts `## <title>\n<content>` per entry,
        // and `<content>` is the line-oriented `chapterEntryContent` block. Both keys are unknown to the Summary
        // catalog, so `phraseGroupRank` ties them and the composer keeps the caller's order (its own documented
        // rule) — which is what makes the expected payload below exact. The `\n` that ends a heading line is NOT a
        // break (the heading consumed it), while every `\n` inside an entry IS one.
        const overview = composePhraseContent([
            {
                key: 'chapter_1',
                title: 'Chapter 1 — The Salt Road',
                content: chapterEntryContent({ id: 'chapter_1' } as unknown as PhraseGroup, {
                    must_happen: 'the crossing is attempted',
                    must_change: 'Wren loses the map'
                })
            },
            {
                key: 'chapter_2',
                title: 'Chapter 2 — The Gate',
                content: chapterEntryContent({ id: 'chapter_2' } as unknown as PhraseGroup, {
                    heading: 'The Gate',
                    must_happen: 'the gate is forced',
                    must_change: 'the key is spent'
                })
            }
        ]);

        expect(overview).toBe(
            '## Chapter 1 — The Salt Road\nMust happen: the crossing is attempted\n' +
                'Must change: Wren loses the map\n\n' +
                '## Chapter 2 — The Gate\nHeading: The Gate\nMust happen: the gate is forced\nMust change: the key is spent'
        );

        const { container } = render(<MarkdownText>{overview}</MarkdownText>);
        const wrapper = container.querySelector('.sv-markdown') as HTMLElement;

        expect(Array.from(wrapper.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => h.textContent)).toEqual([
            'Chapter 1 — The Salt Road',
            'Chapter 2 — The Gate'
        ]);
        // The `## ` marker is gone, which is the symptom the user reported, and the two entries are two
        // paragraphs — the blank line between entries is still a block break, not a break.
        expect(wrapper.textContent).not.toContain('## ');
        expect(wrapper.querySelectorAll('p')).toHaveLength(2);
        expect(wrapper.querySelectorAll('br')).toHaveLength(3);
        expect(renderedLines(wrapper)).toEqual([
            'Chapter 1 — The Salt Road',
            'Must happen: the crossing is attempted',
            'Must change: Wren loses the map',
            'Chapter 2 — The Gate',
            'Heading: The Gate',
            'Must happen: the gate is forced',
            'Must change: the key is spent'
        ]);
    });

    it('writes one break per newline the author wrote, and never two', () => {
        // The three ways a line break is spelled in markdown, and the two shapes a producer can end a text with.
        // Each input has exactly one newline, so each render has exactly one `<br>`: `remark-breaks` converts the
        // newline ITSELF into the break, so an author who also typed the markdown hard-break (`  ` or `\`) gets
        // one break, not a doubled one, and a trailing newline cannot open an empty line.
        const spellings: Array<[string, string[]]> = [
            ['A:\nB:', ['A:', 'B:']],
            ['A  \nB', ['A', 'B']],
            ['A\\\nB', ['A', 'B']],
            ['A:\r\nB:', ['A:', 'B:']],
            ['A:\nB:\n', ['A:', 'B:']]
        ];

        for (const [source, expected] of spellings) {
            const { container, unmount } = render(<MarkdownText>{source}</MarkdownText>);
            const wrapper = container.querySelector('.sv-markdown') as HTMLElement;

            expect(wrapper.querySelectorAll('br')).toHaveLength(1);
            expect(renderedLines(wrapper)).toEqual(expected);
            unmount();
        }
    });

    it('leaves fenced code byte-for-byte intact — the writer’s newlines inside a fence are not breaks', () => {
        // AC3: a fence is where a broken line is WORST, because the corruption is silent and the reader cannot
        // see it. The `\n` inside the fence is the code's own text; a `<br>` in there would mean a line ending
        // the compiler does not have, and the copy affordance would hand back something else.
        const fenced = 'The revision ran:\n\n```ts\nconst ok = true;\nconst no = false;\n```\n';
        const { container } = render(<MarkdownText>{fenced}</MarkdownText>);
        const wrapper = container.querySelector('.sv-markdown') as HTMLElement;

        expect(wrapper.querySelector('pre code')?.textContent).toBe('const ok = true;\nconst no = false;\n');
        expect(wrapper.querySelector('pre')?.querySelectorAll('br')).toHaveLength(0);
        // Nothing in the payload gained a break at all: the newline the prose line ends with is followed by a
        // BLANK line, so it is a paragraph boundary, and the fence's newlines stayed inside the fence.
        expect(wrapper.querySelectorAll('br')).toHaveLength(0);
    });

    it('changes nothing about markdown that is paragraphed the markdown way', () => {
        // AC3: the hard breaks are ADDITIVE. Blank-line-separated paragraphs, a GFM table, a list, emphasis and
        // inline code all render as they did before the plugin, and NOT one of them gains a `<br>`.
        const markdown = [
            '## Criteria',
            '',
            'A **keeper** reads the `ledger`.',
            '',
            '- first',
            '- second',
            '',
            '| Group | Score |',
            '| --- | --- |',
            '| Premise | 79 |',
            '',
            '> Salt in every image.'
        ].join('\n');
        const { container } = render(<MarkdownText>{markdown}</MarkdownText>);
        const wrapper = container.querySelector('.sv-markdown') as HTMLElement;

        expect(blocks(wrapper)).toEqual([
            'H2:Criteria',
            'P:A keeper reads the ledger.',
            'UL:first|second',
            // The table's textContent is the cells, concatenated — the cells themselves are asserted by hand
            // below, because `blocks()` cannot separate them.
            'TABLE:GroupScorePremise79',
            // `blocks()` reports a blockquote AND the paragraph inside it, and the blockquote's own textContent
            // holds the newlines react-markdown writes around that paragraph.
            'BLOCKQUOTE:\nSalt in every image.\n',
            'P:Salt in every image.'
        ]);
        expect(wrapper.querySelectorAll('br')).toHaveLength(0);
        expect(wrapper.querySelector('thead th')?.textContent).toBe('Group');
        expect(Array.from(wrapper.querySelectorAll('tbody td')!).map((cell) => cell.textContent)).toEqual([
            'Premise',
            '79'
        ]);
        expect(wrapper.querySelector('strong')?.textContent).toBe('keeper');
        expect(wrapper.querySelector('code')?.textContent).toBe('ledger');
    });

    it('renders two blank-line-separated paragraphs as exactly that, with no break between them', () => {
        // The exact markup, spelled out: `remark-breaks` fires on newlines, and a blank line has none left to
        // fire on once the paragraph boundary is taken.
        const { container } = render(<MarkdownText>{'First paragraph.\n\nSecond paragraph.'}</MarkdownText>);

        expect(container.querySelector('.sv-markdown')?.innerHTML).toBe(
            '<p>First paragraph.</p>\n<p>Second paragraph.</p>'
        );
    });
});

describe('MarkdownText — the optional hooks are additive (SummaryOverviewPane / SummaryPane)', () => {
    it('always carries `sv-markdown`, and writes no `data-testid` when `testId` is absent', () => {
        const { container } = render(<MarkdownText>plain</MarkdownText>);
        const wrapper = container.querySelector('div') as HTMLElement;

        expect(wrapper.className).toBe('sv-markdown');
        // `null`, not `''`: the pane tests that assert an absent Summary assert `queryByTestId(...) === null`.
        expect(wrapper.hasAttribute('data-testid')).toBe(false);
    });

    it('APPENDS `className` after `sv-markdown`, and puts `testId` on that same wrapper', () => {
        const { container } = render(
            <MarkdownText className="sv-summary-text" testId="summary-text">
                {OVERVIEW}
            </MarkdownText>
        );
        const wrapper = screen.getByTestId('summary-text');

        // One element carries both hooks: `.sv-summary-text` is the pane's sizing rule and `.sv-markdown` is
        // the block scale, and neither may end up on a wrapper the other is not looking at. The order is the
        // one `styles/story.css`'s `.sv-summary-text.sv-markdown` overrides assume.
        expect(wrapper.className).toBe('sv-markdown sv-summary-text');
        expect(wrapper.classList.contains('sv-markdown')).toBe(true);
        expect(wrapper.querySelector('h2')?.textContent).toBe('Premise');
        expect(container.querySelectorAll('.sv-markdown')).toHaveLength(1);
    });

    it('treats an empty `className` as no hook at all', () => {
        const { container } = render(<MarkdownText className="">plain</MarkdownText>);

        // A trailing space in the attribute is how a careless append shows up in a DOM snapshot.
        expect((container.querySelector('div') as HTMLElement).className).toBe('sv-markdown');
    });
});
