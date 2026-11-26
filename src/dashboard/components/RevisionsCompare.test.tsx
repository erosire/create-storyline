// U-13 / D-21 / D-22 / D-24 — revision comparison: the drafts of one unit side by side.
//
// The Author's window onto divergence is literal columns (U-13), the §4.9 verdict rows and the Editor's
// `selection_note` ride with each draft (D-21, L-17), and the Select control states the missing endpoint
// rather than pretending the Author's override exists (D-24).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RevisionsCompare } from './RevisionsCompare';
import { buildRevisionUnits, revisionBodyText } from './story-contract';
import { click } from '../testing/shell-fakes';
import { fixtureActions, fixtureView } from './story-fixtures';

/** The unit the fixture Story is contested on (D-23: it cannot advance until one is chosen). */
function contestedUnit() {
    return buildRevisionUnits(fixtureView()).filter((unit) => unit.unitRef === 'c2');
}

/**
 * Every block the body renderer emitted under `root`, in DOM order, as `TAG:text` — the shape
 * `MarkdownText.test.tsx:26-39` pins, so the pane test asserts on STRUCTURES rather than on a string that
 * happens to contain the words. A list reports its items, because a list's own `textContent` joins them
 * without separators and would hide a dropped one.
 */
function blocksOf(root: ParentNode): string[] {
    return Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol,table,pre,blockquote,hr')).map((block) => {
        if (block.tagName === 'UL' || block.tagName === 'OL') {
            return `UL:${Array.from(block.querySelectorAll('li')).map((item) => item.textContent).join('|')}`;
        }

        return `${block.tagName}:${block.textContent ?? ''}`;
    });
}

/**
 * The Markdown a Summary draft carries: `shared/phrase.ts:composePhraseContent` joins the reviewed groups as
 * `## <title>\n<content>`, which is the text `group_revisions.content` stores and this pane compares.
 */
const MARKDOWN_BODY = [
    '## Premise',
    '',
    'The index **answered** before she touched it.',
    '',
    '- first',
    '- second'
].join('\n');

/**
 * The contested unit with one draft's body replaced by the Markdown a Summary draft actually carries
 * (`revision.body` is `unknown` — §4.15 — and `story-contract.ts:revisionBodyText` flattens a prose-field body
 * to `composePhraseContent`'s `## <title>\n<content>`). The other draft is left alone on purpose, so the pair
 * still shows a rendered draft next to an unmarked one.
 */
function markdownUnit() {
    return contestedUnit().map((unit) => ({
        ...unit,
        revisions: unit.revisions.map((revision) =>
            revision.id === 'rv-c2-a' ? { ...revision, body: MARKDOWN_BODY } : revision
        )
    }));
}

/**
 * The contested unit with one draft's body left as the OBJECT §4.15 allows it to be — the prose fields
 * themselves, the shape `story-contract.ts:revisionBodyText` flattens. The two fields are the fixture's own
 * Summary body (`rv-sum-a`), so nothing is invented: the text this pane renders is exactly what
 * `revisionBodyText` emits from them, and the wire really does send the object.
 */
function lineOrientedUnit() {
    return contestedUnit().map((unit) => ({
        ...unit,
        revisions: unit.revisions.map((revision) =>
            revision.id === 'rv-c2-a'
                ? {
                      ...revision,
                      body: {
                          premise: 'A flooded city keeps its memory in a sealed cathedral of data.',
                          ending: 'She seals the index with her own voice in it.'
                      }
                  }
                : revision
        )
    }));
}

describe('RevisionsCompare — the Author\u2019s window onto divergence (U-13, D-21, D-24)', () => {
    it('renders each draft as its own column, with its state, template, run, and its own verdict rows', () => {
        render(
            <RevisionsCompare
                units={contestedUnit()}
                note="2 competing drafts — the unit cannot advance until an Editor selects (D-23, L-20)"
            />
        );

        expect(screen.getByText('Chapter 2 — Ghost Index · 2 drafts (chapter)')).toBeTruthy();
        const columns = Array.from(document.querySelectorAll<HTMLElement>('.sv-revision-col'));
        expect(columns.length).toBe(2);
        expect(columns.map((column) => column.className)).toEqual([
            'sv-revision-col sv-revision-competing',
            'sv-revision-col sv-revision-competing'
        ]);

        // U-13 / D-21: the verdicts are the REAL §4.9 rows, not the bare refs the pane printed while the
        // view had no `verdicts` slice. rv-c2-a was judged twice — a failing pass and a newer pass.
        const verdictsOf = (column: HTMLElement) =>
            Array.from(column.querySelectorAll<HTMLElement>('.sv-revision-verdict')).map(
                (node) =>
                    `${node.querySelector('.sv-revision-verdict-state')?.textContent}|${node.querySelector('.sv-revision-verdict-id')?.textContent}|${node.querySelector('.sv-revision-verdict-recommendation')?.textContent}`
            );

        expect(verdictsOf(columns[0])).toEqual([
            'hard fail|v-1 · chapter · round 1|recommends fix',
            'hard pass|v-2 · chapter · round 2|recommends advance'
        ]);

        // D-15: the failing line is shown WITH its citation — the evidence is the point of the row.
        expect(
            (columns[0].querySelector('.sv-revision-verdict-fail .sv-revision-verdict-failure') as HTMLElement)
                .textContent
        ).toBe('C-8 failing — the 1911 survey is named once and never paid off (D-15 evidence) (finding f-2)');

        // rv-c2-b has no verdict naming it, so the pane says which judgement it is showing rather than
        // passing the unit's rows off as the draft's own.
        expect(verdictsOf(columns[1])).toEqual(['hard fail|v-3 · chapter · round 1|recommends fix']);
        expect(within(columns[1]).getByText('no verdict names this draft — these were filed against c2')).toBeTruthy();
        expect(within(columns[0]).getByText('t-chapters')).toBeTruthy();
        expect(within(columns[0]).getByText('run r-5')).toBeTruthy();
        expect(within(columns[1]).getByText('run r-6')).toBeTruthy();

        // A chapter body is its sections, rendered as the prose reads (D-7). The body is rendered Markdown now
        // (`revision.body` is phrase prose — `group_revisions.content`), and a body with no Markdown syntax in it
        // is ONE paragraph whose text is the string itself, so the sentence is still exact: the renderer is not a
        // rewriter. The class sits on the renderer's wrapper, which is what keeps the comparison box's padding and
        // surface (`.sv-revision-body` in `styles/story.css`) and keeps that class the hook tests query.
        const bodies = Array.from(document.querySelectorAll<HTMLElement>('.sv-revision-body'));

        expect(bodies.map((body) => body.className)).toEqual([
            'sv-markdown sv-revision-body',
            'sv-markdown sv-revision-body'
        ]);
        expect((columns[0].querySelector('.sv-revision-body') as HTMLElement).textContent).toBe(
            'The index answered before she touched it, in a voice she had heard read aloud years earlier.'
        );
        expect((columns[1].querySelector('.sv-revision-body') as HTMLElement).textContent).toBe(
            'The index answered in her own voice, and she did not recognise it.'
        );
        // The verdict rows and the selection note are NOT prose and stay plain (U-13/L-17): only the body moved
        // into the renderer, so exactly one Markdown wrapper sits in each column.
        expect(columns.map((column) => column.querySelectorAll('.sv-markdown').length)).toEqual([1, 1]);

        // D-22: the losers are deleted by the selection commit, and nothing promises a restore.
        expect(
            screen.getByText(
                "A discarded draft is not restorable in this view: the selection commit deletes it hard (D-22), and D-24's restore needs the run's own output, which lands with the run-transcript endpoint."
            )
        ).toBeTruthy();
        expect(
            screen.getByText('the losers are deleted in the selection commit; the note survives (D-22)')
        ).toBeTruthy();
    });

    it('renders a draft body as Markdown — a group title is a heading, not its source (D-7)', () => {
        render(<RevisionsCompare units={markdownUnit()} />);

        const columns = Array.from(document.querySelectorAll<HTMLElement>('.sv-revision-col'));
        const body = columns[0].querySelector('.sv-revision-body') as HTMLElement;

        // The pane's hook is on the renderer's wrapper, so the box keeps its padding and surface
        // (`.sv-revision-body` in `styles/story.css`) and that class stays the selector tests use.
        expect(body.className).toBe('sv-markdown sv-revision-body');
        expect(blocksOf(body)).toEqual([
            'H2:Premise',
            'P:The index answered before she touched it.',
            'UL:first|second'
        ]);
        // The markers a reader must not see: the heading's `## ` and the emphasis's `**` are structure now, and
        // the emphasis is a real element rather than two asterisks in the sentence.
        expect(body.textContent).not.toContain('## ');
        expect(body.textContent).not.toContain('**');
        expect(body.querySelector('strong')?.textContent).toBe('answered');
        expect(Array.from(body.querySelectorAll('li')).map((item) => item.textContent)).toEqual(['first', 'second']);
        // The other column is untouched: only the body text is Markdown, never the verdict rows, the state badge
        // or the selection note (U-13, L-17), and one draft with no Markdown is still one plain paragraph.
        expect((columns[1].querySelector('.sv-revision-body') as HTMLElement).textContent).toBe(
            'The index answered in her own voice, and she did not recognise it.'
        );
        expect(
            (columns[0].querySelector('.sv-revision-verdict-state') as HTMLElement).textContent
        ).toBe('hard fail');
    });

    it('keeps a body the wire sent as fields on one line per field — the newline is the layout (D-7)', () => {
        // WHY THE TEST ABOVE IS NOT ENOUGH. §4.15's `body` is `unknown`, and `story-contract.ts:revisionBodyText`
        // flattens an OBJECT body to `key: value` lines joined with a SINGLE `\n` — the same line-oriented shape
        // `server/phrase/plotpoints.ts:chapterEntryContent` stores for a chapter entry. Until U-23 this node was a
        // literal `<pre>`, so the UA's `white-space: pre-wrap` is what had kept those two fields apart; rendered
        // markdown is a `<div>` under `normal`, where markdown itself folds a lone newline into a space. The break
        // is markup now (`MarkdownText` runs `remark-breaks`), and this is the pin that says it stayed one.
        const body = {
            premise: 'A flooded city keeps its memory in a sealed cathedral of data.',
            ending: 'She seals the index with her own voice in it.'
        };

        // THE PRODUCER'S OWN BYTES — one `\n`, no blank line for markdown to paragraph on.
        expect(revisionBodyText(body)).toBe(
            'premise: A flooded city keeps its memory in a sealed cathedral of data.\n' +
                'ending: She seals the index with her own voice in it.'
        );

        render(<RevisionsCompare units={lineOrientedUnit()} />);

        const columns = Array.from(document.querySelectorAll<HTMLElement>('.sv-revision-col'));
        const first = columns[0].querySelector('.sv-revision-body') as HTMLElement;

        // One paragraph box, because markdown has no reason to make two, and one real break where the flattener
        // put one newline. The markup is spelled out because `textContent` cannot tell this apart from the
        // flattened regression: under `white-space: normal` both read as one line of text.
        expect(first.className).toBe('sv-markdown sv-revision-body');
        expect(first.querySelectorAll('p')).toHaveLength(1);
        expect(first.querySelectorAll('br')).toHaveLength(1);
        expect(first.innerHTML).toBe(
            '<p>premise: A flooded city keeps its memory in a sealed cathedral of data.<br>\n' +
                'ending: She seals the index with her own voice in it.</p>'
        );
        // The draft beside it is a string body with no markdown in it, and it is still one plain paragraph: the
        // renderer has not become a rewriter for text that needed no structure.
        expect((columns[1].querySelector('.sv-revision-body') as HTMLElement).textContent).toBe(
            'The index answered in her own voice, and she did not recognise it.'
        );
        expect((columns[1].querySelector('.sv-revision-body') as HTMLElement).querySelectorAll('br')).toHaveLength(0);
    });

    it('disables Select only when the host passes no callback, and says which state that is', () => {
        render(<RevisionsCompare units={contestedUnit()} />);

        const selects = Array.from(document.querySelectorAll<HTMLButtonElement>('.sv-revision-select'));
        expect(selects.length).toBe(2);
        expect(selects.every((button) => button.disabled)).toBe(true);
        // The route exists, so a disabled control is a mounting question and the tooltip says so — the
        // copy used to blame a missing endpoint that has since landed (U-13).
        expect(selects[0].getAttribute('title')).toBe(
            'This pane was mounted without a selection callback, so the Author cannot choose from here (D-24)'
        );
    });

    it('lets the Author override the Editor once the route exists, with the unit and the draft it names (D-24)', async () => {
        const { actions, calls } = fixtureActions();
        render(
            <RevisionsCompare
                units={contestedUnit()}
                onSelectRevision={(unitRef, revisionId) => void actions.selectRevision?.(unitRef, revisionId)}
            />
        );

        // The second column is the draft the Editor did not pick — the Author's override target (D-24).
        await click(
            within(document.querySelectorAll<HTMLElement>('.sv-revision-col')[1]).getByRole('button', {
                name: 'Select this draft'
            })
        );
        expect(calls.selectRevision).toEqual([['c2', 'rv-c2-b']]);
    });

    it('shows the Editor\u2019s selection note on the draft that was chosen — the Author\u2019s only view of automated taste (L-17, T-2a)', () => {
        const selected = buildRevisionUnits(fixtureView()).filter((unit) => unit.unitRef === 'c1');
        render(<RevisionsCompare units={selected} />);

        expect(screen.getByText('Chapter 1 — The Sealed Stack · 1 draft (chapter)')).toBeTruthy();
        expect(
            screen.getByText(
                'selection note — Chose the citation line: it makes the refusal a fact she can quote (D-24).'
            )
        ).toBeTruthy();
        expect((document.querySelector('.sv-revision-state') as HTMLElement).textContent).toBe('selected');
    });

    it('renders nothing at all when there is nothing to compare', () => {
        const { container } = render(<RevisionsCompare units={[]} />);
        expect(container.innerHTML).toBe('');
    });
});
