// T14 — the Summary card's section-heading rule, pinned as a pure text transform.
//
// What is pinned here is the RULE, not the render (the render is `SummaryOverviewPane.test.tsx`): the exact
// output string for an exact input string, plus the edge cases that decide whether the rule is a heading
// scanner or a find-and-replace. Every expected value below is read off the input, never observed from a run.
//
// The shape that matters: the producer's text (`shared/phrase.ts:composePhraseContent` — one `## <title>` per
// non-empty group, body under it, blank line between, no trailing newline) comes out with ONLY its section
// headings changed. Everything else — body bytes, `###` lines, fenced code, blank lines, line endings, the
// absence of a trailing newline — is byte-identical, because that same text is what Phrase ② copies onto its
// Seed and hashes (§4.20 / D-72) and because D-65 forbids a Reader's number from becoming stored content.
import { describe, expect, it } from 'vitest';

import { decorateSummaryOverview } from './summary-heading';
import { composePhraseContent, orderedPhraseGroupDefinitions } from '../../shared/phrase';
import type { SummaryHeadingRow } from './summary-heading';

/** The five titles the producer writes headings from — the catalog, not a list this file invents. */
const CATALOG_TITLES = orderedPhraseGroupDefinitions().map((definition) => definition.title);

/** A row, spelled the way the pane's reviewed rows answer it (`title` + the two display numbers). */
function row(overrides: Partial<SummaryHeadingRow> & { title: string }): SummaryHeadingRow {
    return { ...overrides };
}

describe('summary-heading — the section heading carries the revision and the score', () => {
    it('decorates a `## <title>` line with `(v<revision>)` and `<pct>%`, in the user\'s format', () => {
        expect(decorateSummaryOverview('## Premise', [row({ title: 'Premise', revision: 7, score: 100 })])).toBe(
            '## Premise (v7) 100%'
        );
    });

    it('uses the catalog titles it is given, and the rows decide which heading is which', () => {
        // The titles the producer can write, and the reason matching is by title rather than by position: the
        // rows arrive in the pane's order and the Overview arrives in the PRODUCER's order, and those are the
        // same order only while the catalog's `order` matches the composition rank.
        expect(CATALOG_TITLES).toEqual(['Premise', 'Promise', 'Theme', 'Tone', 'Ending']);

        const text = ['## Ending', 'The gate stays shut.', '', '## Premise', 'A keeper lies to the sea.'].join('\n');

        expect(
            decorateSummaryOverview(text, [
                row({ title: 'Premise', revision: 7, score: 100 }),
                row({ title: 'Ending', revision: 2, score: 62 })
            ])
        ).toBe(
            '## Ending (v2) 62%\nThe gate stays shut.\n\n## Premise (v7) 100%\nA keeper lies to the sea.'
        );
    });

    it('decorates the whole producer payload, built by `composePhraseContent` rather than retyped', () => {
        // THE REAL BYTES: `composePhraseContent` is what makes the shape (heading, body, blank line, no trailing
        // newline), so the input below is the producer's, and the expected output differs from it by exactly the
        // two heading suffixes.
        const overview = composePhraseContent([
            { key: 'premise', title: 'Premise', content: 'A keeper of a lighthouse begins lying to the sea.' },
            { key: 'tone', title: 'Tone', content: 'Plain sentences, salt in every image.' }
        ]);

        expect(overview).toBe(
            '## Premise\nA keeper of a lighthouse begins lying to the sea.\n\n' +
                '## Tone\nPlain sentences, salt in every image.'
        );
        expect(
            decorateSummaryOverview(overview, [
                row({ title: 'Premise', revision: 7, score: 100 }),
                row({ title: 'Tone', revision: 3, score: 0 })
            ])
        ).toBe(
            '## Premise (v7) 100%\nA keeper of a lighthouse begins lying to the sea.\n\n' +
                '## Tone (v3) 0%\nPlain sentences, salt in every image.'
        );
    });

    it('prints each number on its own, and neither when the group has neither', () => {
        // AC1's four shapes, exact. An absent score is NOT `0%` and an absent revision is NOT `(v0)` — the rail
        // (`StoryOutline.tsx:681-696`) and the provenance strip already print nothing for an absent number,
        // because an absence is not a judgement (D-65).
        expect(decorateSummaryOverview('## Premise', [row({ title: 'Premise', revision: 7, score: undefined })])).toBe(
            '## Premise (v7)'
        );
        expect(decorateSummaryOverview('## Premise', [row({ title: 'Premise', revision: null, score: 100 })])).toBe(
            '## Premise 100%'
        );
        expect(decorateSummaryOverview('## Premise', [row({ title: 'Premise', revision: null, score: undefined })])).toBe(
            '## Premise'
        );
        expect(decorateSummaryOverview('## Premise', [row({ title: 'Premise' })])).toBe('## Premise');
    });

    it('treats a real 0 as a value, for both numbers', () => {
        // `revision: 0` and `score: 0` are both reachable on the wire and both MEAN something, so the guard is
        // null/undefined (`isInvalid`), never truthiness. A truthy check here would print `Premise` over a
        // Reader's actual `0`.
        expect(decorateSummaryOverview('## Premise', [row({ title: 'Premise', revision: 0, score: 0 })])).toBe(
            '## Premise (v0) 0%'
        );
    });

    it('takes the numbers it is handed — it never re-scales, re-rounds or re-derives them (D-65)', () => {
        // `story-contract.ts:phraseScorePercent` is the ONE normalizer, and it has already run by the time a row
        // gets here. So the digits the strip prints are the digits the heading prints, including a 100 and a 0.
        expect(decorateSummaryOverview('## Premise', [row({ title: 'Premise', revision: 12, score: 74 })])).toBe(
            '## Premise (v12) 74%'
        );
        expect(decorateSummaryOverview('## Premise', [row({ title: 'Premise', revision: 1, score: 100 })])).toBe(
            '## Premise (v1) 100%'
        );
    });

    it('ignores a row whose title only differs by whitespace, and never emits the whitespace', () => {
        expect(decorateSummaryOverview('## Premise', [row({ title: '  Premise  ', revision: 7, score: 100 })])).toBe(
            '## Premise (v7) 100%'
        );
        // A row with no title at all cannot address a section (`## ` is not a heading), so nothing is decorated.
        expect(decorateSummaryOverview('## Premise', [row({ title: '   ', revision: 7, score: 100 })])).toBe('## Premise');
    });

    it('lets the first row win when a payload repeats a title, rather than inventing a third number', () => {
        expect(
            decorateSummaryOverview('## Premise', [
                row({ title: 'Premise', revision: 7, score: 100 }),
                row({ title: 'Premise', revision: 9, score: 50 })
            ])
        ).toBe('## Premise (v7) 100%');
    });

    it('is a no-op on an empty Overview, and on a text with no rows to decorate it with', () => {
        expect(decorateSummaryOverview('', [row({ title: 'Premise', revision: 7, score: 100 })])).toBe('');
        expect(decorateSummaryOverview('## Premise\nBody.', [])).toBe('## Premise\nBody.');
        // AC2's consequence: with no reviewed rows (a partial selection, or a payload that predates D-67), the
        // text the pane prints is the wire's text, character for character.
        expect(decorateSummaryOverview('## Premise\nBody.', [row({ title: 'Nowhere', revision: 4, score: 90 })])).toBe(
            '## Premise\nBody.'
        );
    });
});

describe('summary-heading — what is NOT a section heading', () => {
    it('leaves a body line that starts `## ` but is not a catalog group title', () => {
        // The Author's prose can quote a heading, and the deep review's text can carry an outline. Matching is
        // EXACT title equality, so `## Something` is body text no row addresses — and `## Premise II` is a
        // different title from `Premise`, not a fuzzy match of one.
        const text = [
            '## Premise',
            'The Author wrote a line that reads ## Something else in its middle.',
            '## Something',
            'and ## Premise II is a different section of the same book.',
            '### Premise',
            'A sub-heading under Premise.'
        ].join('\n');

        expect(decorateSummaryOverview(text, [row({ title: 'Premise', revision: 7, score: 100 })])).toBe(
            [
                '## Premise (v7) 100%',
                'The Author wrote a line that reads ## Something else in its middle.',
                '## Something',
                'and ## Premise II is a different section of the same book.',
                '### Premise',
                'A sub-heading under Premise.'
            ].join('\n')
        );
    });

    it('leaves an indented code line, an unspaced `##Premise`, and a deeper heading alone', () => {
        // Three markdown forms that LOOK like the target and are not: four spaces of indent is indented CODE
        // (CommonMark), `##Premise` has no space so it is one paragraph of text, and `#### Premise` is an h4.
        expect(
            decorateSummaryOverview('    ## Premise\nBody', [row({ title: 'Premise', revision: 7, score: 100 })])
        ).toBe('    ## Premise\nBody');
        expect(
            decorateSummaryOverview('##Premise\nBody', [row({ title: 'Premise', revision: 7, score: 100 })])
        ).toBe('##Premise\nBody');
        expect(
            decorateSummaryOverview('# Premise\n#### Premise\nBody', [row({ title: 'Premise', revision: 7, score: 100 })])
        ).toBe('# Premise\n#### Premise\nBody');
    });

    it('matches a heading indented up to three spaces, and trims only the heading line\'s trailing spaces', () => {
        // ATX allows three spaces of indent and ignores trailing spaces, so both are still the section heading —
        // and the opener's bytes survive, because this rule appends to the line rather than rewriting it.
        expect(
            decorateSummaryOverview('   ## Premise\nBody', [row({ title: 'Premise', revision: 7, score: 100 })])
        ).toBe('   ## Premise (v7) 100%\nBody');
        expect(
            decorateSummaryOverview('## Premise   \nBody', [row({ title: 'Premise', revision: 7, score: 100 })])
        ).toBe('## Premise (v7) 100%\nBody');
        // With nothing to append, even those trailing spaces are kept: the no-decoration output is the input.
        expect(
            decorateSummaryOverview('## Premise   \nBody', [row({ title: 'Premise', revision: null, score: undefined })])
        ).toBe('## Premise   \nBody');
    });

    it('leaves every `## Premise` inside a fenced code block literal', () => {
        // The Overview is agent-authored markdown and a Writer can quote its own structure back at the Author
        // (the Handoff card's copied-Seed prefix does exactly this). A fence is code: no decoration, and the
        // fence's own bytes untouched.
        const text = [
            '```',
            '## Premise',
            'quoted',
            '```',
            '',
            '## Premise',
            'The real section.',
            '',
            '~~~',
            '## Premise',
            '``` not a closer for a tilde fence',
            '~~~'
        ].join('\n');

        expect(decorateSummaryOverview(text, [row({ title: 'Premise', revision: 7, score: 100 })])).toBe(
            [
                '```',
                '## Premise',
                'quoted',
                '```',
                '',
                '## Premise (v7) 100%',
                'The real section.',
                '',
                '~~~',
                '## Premise',
                '``` not a closer for a tilde fence',
                '~~~'
            ].join('\n')
        );
    });

    it('treats an unclosed fence the way markdown does — it swallows the rest of the document', () => {
        // The failure mode is a Writer that opens a fence and never closes it. Markdown then reads everything
        // after it as code, so decorating a heading down there would be the card disagreeing with the render.
        const text = '```\n## Premise\nstill code\n';

        expect(decorateSummaryOverview(text, [row({ title: 'Premise', revision: 7, score: 100 })])).toBe(text);
    });

    it('leaves a blockquoted heading alone, and appends to a heading line inside a raw HTML block', () => {
        // Two forms the rule handles narrowly, both tolerance for agent prose rather than producer output (the
        // module's comment above states why). `> ## Premise` does not START with the heading, so it is not a
        // section heading and it stays exactly as written. A line at column 0 inside an HTML block IS a line
        // starting with the heading, so it is decorated — and since the pane escapes raw HTML (no `rehype-raw`,
        // U-23), that line was already being read as characters, marker included.
        const rows = [row({ title: 'Premise', revision: 7, score: 100 })];

        expect(decorateSummaryOverview('> ## Premise\n> Body.', rows)).toBe('> ## Premise\n> Body.');
        expect(decorateSummaryOverview('<div>\n## Premise\n</div>', rows)).toBe('<div>\n## Premise (v7) 100%\n</div>');
    });

    it('decorates only the FIRST occurrence of a title, because one group has one section', () => {
        // A second line that is exactly `## Premise` is prose quoting the section (or a Writer echoing the
        // composer), and decorating both would put the same revision on two sections.
        expect(
            decorateSummaryOverview(
                '## Premise\nBody.\n\n## Premise\nA second line that repeats the heading.',
                [row({ title: 'Premise', revision: 7, score: 100 })]
            )
        ).toBe('## Premise (v7) 100%\nBody.\n\n## Premise\nA second line that repeats the heading.');
    });
});

describe('summary-heading — the output is the same document, once', () => {
    it('is idempotent: feeding its own output back in changes nothing', () => {
        // The rule has to survive a pane that re-renders over text it already decorated (a re-read landing
        // twice, or a future caller that hands over a decorated Overview). The guard is the match itself: the
        // decorated text `Premise (v7) 100%` is no longer any group's title.
        const rows = [row({ title: 'Premise', revision: 7, score: 100 }), row({ title: 'Tone', revision: 3, score: 88 })];
        const once = decorateSummaryOverview(
            ['## Premise', 'A keeper lies to the sea.', '', '## Tone', 'Salt in every image.'].join('\n'),
            rows
        );

        expect(once).toBe(
            '## Premise (v7) 100%\nA keeper lies to the sea.\n\n## Tone (v3) 88%\nSalt in every image.'
        );
        expect(decorateSummaryOverview(once, rows)).toBe(once);
        expect(decorateSummaryOverview(decorateSummaryOverview(once, rows), rows)).toBe(once);
    });

    it('changes no body byte, no blank line, no line ending, and no trailing newline', () => {
        const rows = [row({ title: 'Premise', revision: 7, score: 100 }), row({ title: 'Tone', revision: 4, score: 61 })];

        // The producer's rule: no trailing newline. A `\n\n` in the middle is the entry separator.
        const noTrailingNewline = '## Premise\nLine one.\nLine two.\n\n## Tone\nVoice: spare';

        expect(decorateSummaryOverview(noTrailingNewline, rows)).toBe(
            '## Premise (v7) 100%\nLine one.\nLine two.\n\n## Tone (v4) 61%\nVoice: spare'
        );

        // A text that DOES end with a newline keeps it — the function adds and removes nothing at the end.
        const trailing = '## Premise\nLine one.\n';

        expect(decorateSummaryOverview(trailing, rows)).toBe('## Premise (v7) 100%\nLine one.\n');

        // CRLF in, CRLF out: `\r` is a line ending here, not a character appended to a body line.
        const crlf = '## Premise\r\nLine one.\r\n\r\n## Tone\r\nVoice: spare';

        expect(decorateSummaryOverview(crlf, rows)).toBe(
            '## Premise (v7) 100%\r\nLine one.\r\n\r\n## Tone (v4) 61%\r\nVoice: spare'
        );

        // A lone `\r` (a pre-OSX line ending) round-trips too, and an all-CR document still decorates.
        expect(decorateSummaryOverview('## Premise\rLine one.', rows)).toBe('## Premise (v7) 100%\rLine one.');
    });

    it('leaves a heading whose group has no numbers at all byte-for-byte identical, whole document included', () => {
        // Not a formatting pass: no normalised opener, no stripped indent, no added newline at EOF. Whatever
        // this function cannot decorate, it does not touch.
        const text = '## Premise\n\n   ## Tone\nVoice: spare\n';
        const rows = [row({ title: 'Premise', revision: null, score: undefined }), row({ title: 'Tone', revision: null, score: undefined })];

        expect(decorateSummaryOverview(text, rows)).toBe(text);
    });
});
