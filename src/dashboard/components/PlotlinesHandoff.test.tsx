// T-W4 — the handoff card: the one verb that turns the finished Summary into Phrase ②'s Seed.
//
// What this suite pins is the CARD'S SIDE of the contract, which no other file can:
//   1. the ENABLE condition is the projection's flag (`story.summary_compiled`), not a client-side guess from the
//      group rows — a button that enabled on its own reading would be refused by the route it is aiming at;
//   2. the START BODY names exactly one arm (`{source:'compiled'}` or `{source:'custom', text}`), because
//      `routes.ts:PhraseStartBody` reads one arm per request and a stray `text` beside `'compiled'` is a 400;
//   3. a shut control states the reason it is shut, in the wire's or the shell's own words (U-16);
//   4. once the phrase has started the card is a RECEIPT — the start is one-way (D-72), so a live button here
//      would promise a write the route refuses with a 409.
// The verb's arguments are asserted as recorded argument lists (`calls.startPhrase`), never as "was called".
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlotlinesHandoff } from './PlotlinesHandoff';
import { fixtureActions, fixturePhrase, fixtureView } from './story-fixtures';
import type { StorySelection } from './story-nav';
// R7 — the notice the card prints beside a shut compiled arm is the contract module's derivation, and this file
// asserts the pane renders THAT string, not a copy of it the pane could reword. The cleanup's four sentences are
// asserted the same way: the card chooses which one to show, and this file proves it showed that one.
import {
    plotlinesCustomStartNotice,
    SEED_CLEANUP_APPLIED_NOTE,
    SEED_CLEANUP_NOTHING_TO_FIX,
    SEED_CLEANUP_PROPOSAL_NOTE,
    seedCleanupAskRefusal,
    seedCleanupRefusalNotice
} from './story-contract';
import type { StoryViewData } from './story-contract';
import { click, phraseDetailView, type } from '../testing/shell-fakes';
import type { PhraseDetailView, SeedCleanupProposal } from '../api';

/**
 * The grouped book, with the two facts the card reads set by the caller. They live on the STORY VIEW
 * (`api.ts:StoryView:319-347`) because the projection computes them; `phraseDetail` is the Phrase ② read, which
 * the receipt's sentence and its copied-Seed head come from.
 */
function handoffView(
    over: { compiled?: boolean; started?: boolean; detail?: PhraseDetailView } = {}
): StoryViewData {
    const view = fixtureView({ phrase: fixturePhrase() });

    return {
        ...view,
        phrase_started: { summary: true, plotlines: over.started === true },
        summary_compiled: over.compiled === true,
        ...(over.detail === undefined ? {} : { phraseDetail: over.detail })
    };
}

/**
 * Every block the renderer emitted under `root`, in DOM order, as `TAG:text` — the shape
 * `MarkdownText.test.tsx:26-39` pins, so a pane test asserts on STRUCTURES (`H2:Premise`) rather than on a
 * string that merely happens to contain `Premise`. A list reports its items, because a list's own
 * `textContent` joins them without separators and would hide a dropped one.
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
 * Mounts the RECEIPT around one Seed head. The head is what the projection sends
 * (`projections.ts:2016`, `seed_head: seed.slice(0, SEED_HEAD_CHARS)`), so a caller passes the exact
 * characters the Author would be shown — whole or cut. Queries stay container-scoped, because the
 * `not.toThrow` assertion mounts the same receipt a second time.
 *
 * R12 — THE PROVENANCE TRAVELS WITH IT. The receipt's sentence names where the Seed came from, and that is a
 * field of the same read (`PhraseDetailView.seed_source`), so this helper passes one — `'compiled'` by default,
 * because every existing pin here is a compiled-arm receipt. `'legacy'` sends NO key at all, which is what the
 * projection does to a row written before the field existed: it omits it rather than guessing.
 */
function mountReceipt(seedHead: string, seedSource: 'custom' | 'compiled' | 'legacy' = 'compiled') {
    const detail = phraseDetailView('s1', {
        seed_head: seedHead,
        seed_chars: seedHead.length,
        ...(seedSource === 'legacy' ? {} : { seed_source: seedSource })
    });

    return render(
        <PlotlinesHandoff
            view={handoffView({ compiled: true, started: true, detail })}
            actions={fixtureActions().actions}
        />
    );
}

/** The head element of one mounted receipt. */
function headOf(container: HTMLElement): HTMLElement {
    return container.querySelector('[data-testid="plotlines-handoff-seed-head"]') as HTMLElement;
}

describe('PlotlinesHandoff — the compiled arm (R5)', () => {
    it('starts Phrase 2 from the compiled Summary in one press, and the body names only that source', () => {
        const { actions, calls } = fixtureActions();
        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);

        // The badge states the gate's state before the button is read: `ready to start` is the compiled flag,
        // and the tone attribute is what the stylesheet colours from.
        expect(screen.getByTestId('plotlines-handoff-state').textContent).toBe('ready to start');
        expect(screen.getByTestId('plotlines-handoff-state').getAttribute('data-tone')).toBe('ready');

        const button = screen.getByTestId('plotlines-handoff-compiled');

        expect(button.hasAttribute('disabled')).toBe(false);
        expect(button.getAttribute('title')).toBe(
            'Start Phrase 2 from the compiled Summary — the Overview is copied into the phrase as its Seed (R5).'
        );
        expect(button.textContent).toBe('Start Phrase 2 from the compiled Summary');

        fireEvent.click(button);

        // THE BODY, EXACTLY: `(storyId, 'plotlines', {source:'compiled'})`. No `text` key — the route reads one
        // arm per request, and an empty or stray one is the 400 the refusal above exists to avoid.
        expect(calls.startPhrase).toEqual([['s1', 'plotlines', { source: 'compiled' }]]);
        // There is no refusal line when the control is live: a warning the Author has to dismiss is noise.
        expect(container.querySelector('[data-testid="plotlines-handoff-refusal"]')).toBeNull();
    });

    it('refuses while the Summary is not compiled, and says where the wait is rather than going dark', () => {
        const { actions, calls } = fixtureActions();
        render(<PlotlinesHandoff view={handoffView({ compiled: false })} actions={actions} />);

        expect(screen.getByTestId('plotlines-handoff-state').textContent).toBe('waiting on the Summary');

        const button = screen.getByTestId('plotlines-handoff-compiled');

        expect(button.hasAttribute('disabled')).toBe(true);
        expect(button.getAttribute('title')).toBe(
            'There is no compiled Summary to start Phrase 2 from yet — the Overview (or the reviewed Summary) is the text the phrase copies, so the gate is above this control (R5).'
        );
        // A disabled button alone does not say WHERE the wait is, so the same sentence sits under the card
        // (the contract module's copy, verbatim — L-13).
        expect(screen.getByTestId('plotlines-handoff-refusal').textContent).toBe(
            'There is no compiled Summary to start Phrase 2 from yet — the Overview (or the reviewed Summary) is the text the phrase copies, so the gate is above this control (R5).'
        );

        // A press on a shut control sends nothing, even when the click is forced through.
        fireEvent.click(button);

        expect(calls.startPhrase).toBeUndefined();
    });

    it('states the missing verb when the shell has no start action, and hides the arm that would need it', () => {
        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: true })} />);

        // U-16: a shut control says WHICH route is missing. This is a pane rendered without a store, and the
        // copy must not pretend the gate is the Summary's.
        expect(screen.getByTestId('plotlines-handoff-compiled').hasAttribute('disabled')).toBe(true);
        expect(screen.getByTestId('plotlines-handoff-refusal').textContent).toBe(
            'The phrase start route is not available in this shell.'
        );
        // The skip arm would open a form whose only verb is the missing one, so it is not rendered at all —
        // a field that cannot be submitted is a promise the shell cannot keep.
        expect(container.querySelector('[data-testid="plotlines-handoff-custom-open"]')).toBeNull();
    });
});

describe('PlotlinesHandoff — the custom-seed arm (the skip)', () => {
    it('is reached by a second click, so the one-press path stays the compiled Summary', () => {
        const { actions } = fixtureActions();
        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);

        expect(container.querySelector('[data-testid="plotlines-handoff-custom"]')).toBeNull();

        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-open'));

        expect(screen.getByTestId('plotlines-handoff-custom')).toBeTruthy();
        expect(screen.getByTestId('plotlines-handoff-custom-note').textContent).toBe(
            'What you write here becomes the Seed instead of the compiled Summary. The Editor ' +
                'structures it into chapters exactly as it does the Overview, and the start is still ' +
                'one-way (D-72).'
        );
        // The compiled arm stays on screen but goes shut while the form is open: the Author can see what the
        // other arm would have done, and the `title` says why it is shut (U-16).
        const compiled = screen.getByTestId('plotlines-handoff-compiled');

        expect(compiled.hasAttribute('disabled')).toBe(true);
        expect(compiled.getAttribute('title')).toBe(
            'The custom Seed form is open — “Keep the compiled Summary” closes it.'
        );
    });

    it('refuses an empty Seed with the route’s own reason, and sends the text trimmed', () => {
        const { actions, calls } = fixtureActions();
        render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);

        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-open'));

        const submit = screen.getByTestId('plotlines-handoff-custom-submit');

        // Empty, and whitespace-only, are the same state to the route (`routes.ts:PhraseStartBody`).
        expect(submit.hasAttribute('disabled')).toBe(true);
        expect(submit.getAttribute('title')).toBe(
            'Write the Seed first — a custom start copies what you type into the phrase, and an empty Seed leaves Phrase 2 with nothing to write from (the route refuses it).'
        );

        fireEvent.change(screen.getByTestId('plotlines-handoff-custom-text'), {
            target: { value: '   six chapters, alternating timeline, no frame story   ' }
        });

        expect(submit.hasAttribute('disabled')).toBe(false);
        expect(submit.getAttribute('title')).toBe('Start Phrase 2 on this text.');

        fireEvent.click(submit);

        // Trimmed, and `source:'custom'` — the two arms differ by exactly this body, so an accidental
        // `{source:'compiled', text}` is the bug this assertion catches.
        expect(calls.startPhrase).toEqual([
            ['s1', 'plotlines', { source: 'custom', text: 'six chapters, alternating timeline, no frame story' }]
        ]);
    });

    it('drops the pending text on send and on cancel, so the next arm starts from the record (P1)', () => {
        const { actions, calls } = fixtureActions();
        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);

        // Cancel: the Author decided against the skip, and the typed text is not part of the record.
        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-open'));
        fireEvent.change(screen.getByTestId('plotlines-handoff-custom-text'), { target: { value: 'a plan' } });
        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-cancel'));

        expect(container.querySelector('[data-testid="plotlines-handoff-custom"]')).toBeNull();
        expect(calls.startPhrase).toBeUndefined();

        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-open'));

        expect((screen.getByTestId('plotlines-handoff-custom-text') as HTMLTextAreaElement).value).toBe('');

        // Send: the same reset, so a receipt appearing beside a stale draft cannot misread as a second pending write.
        fireEvent.change(screen.getByTestId('plotlines-handoff-custom-text'), { target: { value: 'six chapters' } });
        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-submit'));

        expect(calls.startPhrase).toEqual([['s1', 'plotlines', { source: 'custom', text: 'six chapters' }]]);
        expect(container.querySelector('[data-testid="plotlines-handoff-custom"]')).toBeNull();
    });
});

describe('PlotlinesHandoff — the started state is a receipt, not a dead button (D-72)', () => {
    it('reports the copied Seed the read carries, and offers the surface that opened', () => {
        const selections: StorySelection[] = [];
        const { actions, calls } = fixtureActions();
        const detail = phraseDetailView('s1', {
            seed_head: 'Premise: a flooded city.',
            seed_chars: 1_284,
            // R12 — the receipt names the arm, and the arm is a field of THIS read; the sentence below is only
            // true because the read says so.
            seed_source: 'compiled'
        });

        render(
            <PlotlinesHandoff
                view={handoffView({ compiled: true, started: true, detail })}
                actions={actions}
                onSelect={(next) => selections.push(next)}
            />
        );

        expect(screen.getByTestId('plotlines-handoff-started').textContent).toBe('started');
        expect(screen.getByTestId('plotlines-handoff-seed').textContent).toBe(
            'Phrase 2 has started on this Story. Its Seed is 1284 characters of the Summary the crew compiled, and every chapter entry, revision and claim key is written against it (D-72).'
        );
        // Plain prose is prose either way: `MarkdownText` renders one paragraph whose text is the string itself,
        // so the receipt's reading copy survives the switch from printed text to rendered Markdown.
        expect(screen.getByTestId('plotlines-handoff-seed-head').textContent).toBe('Premise: a flooded city.');

        fireEvent.click(screen.getByTestId('plotlines-handoff-open'));

        expect(selections).toEqual([{ panel: 'plotlines' }]);
        // Nothing here can start the phrase again: no live button, and no press.
        expect(screen.queryByTestId('plotlines-handoff-compiled')).toBeNull();
        expect(calls.startPhrase).toBeUndefined();
    });

    // R12 — THE RECEIPT CREDITS THE RIGHT HAND. The sentence used to say "of the Summary the crew compiled" for
    // every started phrase, which the custom arm (R5) made false an Author could see: they had typed the Seed, and
    // the desk told them the crew had written it. `seed_source` is on the row and on the read now, so the receipt
    // reads it — and a row that predates the field gets the third wording, because a projection that OMITS the key
    // must not be answered with a guess about who wrote the text.
    it('credits the Author with a Seed the custom arm supplied (R12)', () => {
        const detail = phraseDetailView('s1', {
            seed_head: 'Six chapters, alternating timeline, no frame story.',
            seed_chars: 47,
            seed_source: 'custom'
        });

        render(<PlotlinesHandoff view={handoffView({ started: true, detail })} actions={fixtureActions().actions} />);

        expect(screen.getByTestId('plotlines-handoff-seed').textContent).toBe(
            'Phrase 2 has started on this Story. Its Seed is 47 characters of the brief you wrote and started on, and every chapter entry, revision and claim key is written against it (D-72).'
        );
    });

    it('says the origin is unrecorded when the row predates the field — absent is never guessed as `compiled` (R12)', () => {
        const detail = phraseDetailView('s1', { seed_head: 'A keeper refuses the relief boat.', seed_chars: 32 });

        // THE FIXTURE ITSELF IS THE ASSERTION: `phraseDetailView` carries no `seed_source` key, exactly as
        // `projections.ts:phraseDetailView` answers a legacy row (omitted, not `null`).
        expect('seed_source' in detail).toBe(false);

        render(<PlotlinesHandoff view={handoffView({ started: true, detail })} actions={fixtureActions().actions} />);

        const sentence = screen.getByTestId('plotlines-handoff-seed').textContent ?? '';

        expect(sentence).toBe(
            'Phrase 2 has started on this Story. Its Seed is 32 characters of text whose origin this desk never recorded — the phrase started before the Seed’s provenance was kept, and every chapter entry, revision and claim key is written against it (D-72).'
        );
        // THE SENTENCE STILL DOES NOT PICK A SIDE. Reading "the crew compiled" into an absent field would tell an
        // Author their own typed brief was the Overview, which is the failure mode AC5 names.
        expect(sentence).not.toContain('the Summary the crew compiled');
        expect(sentence).not.toContain('the brief you wrote');
    });

    it('keeps to the flag it has when the phrase read is not in the frame', () => {
        const { container } = render(
            <PlotlinesHandoff view={handoffView({ started: true })} actions={fixtureActions().actions} />
        );

        // The receipt never invents a character count or a Seed head: with no read it states the flag alone,
        // and the head paragraph is absent rather than empty.
        expect(screen.getByTestId('plotlines-handoff-seed').textContent).toBe(
            'Phrase 2 has started on this Story: its Seed is copied, and every chapter entry, revision and claim key is written against it (D-72).'
        );
        expect(container.querySelector('[data-testid="plotlines-handoff-seed-head"]')).toBeNull();
        // And the live card's badge is gone, not merely hidden: a second status word on the same decision is noise.
        expect(container.querySelector('[data-testid="plotlines-handoff-state"]')).toBeNull();
    });

    it('renders the started state even when the Summary stopped looking compiled', () => {
        const { actions } = fixtureActions();
        render(<PlotlinesHandoff view={handoffView({ started: true, compiled: false })} actions={actions} />);

        // A started phrase's receipt does not depend on the compiled flag: the Summary may move on (a backtrack
        // rewrites it), and the phrase's start is still a fact about the past.
        expect(screen.getByTestId('plotlines-handoff-started').textContent).toBe('started');
        expect(screen.queryByTestId('plotlines-handoff-refusal')).toBeNull();
    });
});

// The head is a 400-character PREFIX of Markdown (`projections.ts:2016`), not a Markdown document: it can end
// mid-`**bold`, mid-`` `code ``, mid-fence, or one line after a `## `. Each case below is pinned with the exact
// blocks the renderer produces, so the next change to the renderer (or to the slice) has to move an expectation
// rather than silently turn the receipt back into the Source view the user reported.
describe('PlotlinesHandoff — the copied Seed head renders as Markdown, cut or whole (D-76)', () => {
    /**
     * A head cut inside an UNTERMINATED fence — the hazard that could in principle hide something. Used by the
     * two tests below, so both describe the same 400-character slice rather than two lookalikes.
     */
    const DANGLING_FENCE =
        '## Premise\nA keeper refuses the relief boat.\n\n```\nthe road collects, and the sea keeps the ledger';

    it('renders `## Premise` as a heading ELEMENT, on the wrapper the pane already addresses', () => {
        // The producer's real shape: `shared/phrase.ts:composePhraseContent` joins the groups as
        // `## <title>\n<content>`, and `phrase-start-routes.test.ts:556` shows the same head un-sliced.
        const seedHead = [
            '## Premise',
            'A keeper refuses the relief boat.',
            '',
            '## Promise',
            'A sealed cathedral of data, salt in every image.'
        ].join('\n');

        const { container } = mountReceipt(seedHead);
        const head = headOf(container);

        // BOTH hooks ride the one wrapper: `sv-summary-text` is the pane's sizing rule and `sv-markdown` is the
        // block scale, in the order `styles/story.css:506-510`'s `.sv-summary-text.sv-markdown` override needs.
        expect(head.className).toBe('sv-markdown sv-summary-text');
        expect(blocksOf(head)).toEqual([
            'H2:Premise',
            'P:A keeper refuses the relief boat.',
            'H2:Promise',
            'P:A sealed cathedral of data, salt in every image.'
        ]);
        // The exact text, block separators included. The `\n` are react-markdown's newlines between sibling blocks,
        // not paragraphing — `.sv-summary-text.sv-markdown { white-space: normal }` collapses them on screen.
        expect(head.textContent).toBe(
            'Premise\nA keeper refuses the relief boat.\nPromise\nA sealed cathedral of data, salt in every image.'
        );
        // The marker the Author used to read as text is gone.
        expect(head.textContent).not.toContain('## ');
        // One wrapper, not a wrapper around a wrapper: a second node would sit between the sizing rule and the prose.
        expect(container.querySelectorAll('.sv-markdown')).toHaveLength(1);
    });

    it.each([
        {
            // CommonMark keeps an UNMATCHED delimiter run as literal text, so a cut inside `**` costs a pair of
            // asterisks and nothing else — no structure is left open.
            case: 'mid `**bold`',
            seedHead: '## Premise\nA keeper **refus',
            blocks: ['H2:Premise', 'P:A keeper **refus']
        },
        {
            // Same rule for a code span: the backtick survives, the paragraph does not.
            case: 'mid `code span`',
            seedHead: '## Premise\nThe ledger is `sealed and never',
            blocks: ['H2:Premise', 'P:The ledger is `sealed and never']
        },
        {
            // A `## ` cut before its body is still a heading — an empty one is a truncated title, not a marker.
            case: 'right after a `## `',
            seedHead: '## Premise\nA keeper refuses the relief boat.\n\n## Prom',
            blocks: ['H2:Premise', 'P:A keeper refuses the relief boat.', 'H2:Prom']
        },
        {
            // An unterminated fence runs to end of DOCUMENT, and its document is this wrapper: the trailing line
            // lands on the fenced-code surface, still legible, with the heading above it intact.
            case: 'inside an unterminated ``` fence',
            seedHead: DANGLING_FENCE,
            blocks: [
                'H2:Premise',
                'P:A keeper refuses the relief boat.',
                // The trailing `\n` is the fence's own line ending, which `remark` keeps inside the code text.
                'PRE:the road collects, and the sea keeps the ledger\n'
            ]
        }
    ])('renders the head cut $case without throwing and without leaking a `## ` marker', ({ seedHead, blocks }) => {
        expect(() => mountReceipt(seedHead)).not.toThrow();

        const { container } = mountReceipt(seedHead);
        const head = headOf(container);

        expect(blocksOf(head)).toEqual(blocks);
        // The FIRST heading is the field the receipt exists for — recognising the text the phrase started on —
        // and no truncation can put it inside a token, because the slice starts at the Seed's start.
        expect(head.querySelector('h2')?.textContent).toBe('Premise');
        expect(head.textContent).not.toContain('## ');
    });

    it('keeps a dangling fence inside the head: nothing the card itself says is swallowed by it', () => {
        const seedHead = DANGLING_FENCE;
        const { container } = mountReceipt(seedHead);
        const head = headOf(container);

        // The risk this pins: a swallowed remainder hiding UI text. It cannot happen — `MarkdownText` renders ONE
        // string in its own `<div>`, so the fence closes at that string's end and the code block holds only prose
        // the projection already sent.
        expect(head.querySelector('pre code')?.textContent).toBe('the road collects, and the sea keeps the ledger\n');
        expect(container.querySelector('[data-testid="plotlines-handoff-started"]')?.textContent).toBe('started');
        expect(container.querySelector('[data-testid="plotlines-handoff-seed"]')?.textContent).toBe(
            `Phrase 2 has started on this Story. Its Seed is ${seedHead.length} characters of the Summary the crew compiled, and every chapter entry, revision and claim key is written against it (D-72).`
        );
        expect(container.querySelector('[data-testid="plotlines-handoff-open"]')?.textContent).toBe('Open Phrase 2');
    });

    it('pins the one residue of a cut: a LATER group title inside a dangling fence shows its marker as code text', () => {
        const seedHead = '## Premise\nA keeper refuses\n```\nthe road collects\n\n## Promise\nA sealed cathedral';
        const { container } = mountReceipt(seedHead);
        const head = headOf(container);

        expect(blocksOf(head)).toEqual([
            'H2:Premise',
            'P:A keeper refuses',
            'PRE:the road collects\n\n## Promise\nA sealed cathedral\n'
        ]);
        // Honest limitation, and the reason the fix is a renderer rather than a rewrite of the projection field:
        // inside a fence CommonMark prints what it is told, so a title that falls in the fenced remainder keeps
        // its `## `. The head's own first heading — the one the Author reads to recognise the Seed — is still an
        // `<h2>`, so no case leaves the receipt showing the marker the user reported for the group it names.
        expect(head.querySelector('h2')?.textContent).toBe('Premise');
        expect(head.textContent).toContain('## Promise');
    });
});

// ---------------------------------------------------------------------------
// R7 (this wave) — THE CUSTOM ARM IS NOT GATED ON THE COMPILED SUMMARY.
//
// What this block owns is the DESK half of a fact the server already had: `routes.ts` validates a `custom` start's
// `text` (400) before it asks whether anything is compiled (the 409), so an Author with a brief of their own could
// start Phrase ② on a book whose Summary was never written — while the card held the button shut on
// `summary_compiled`, the COMPILED arm's problem. The card now answers each arm to its own gate
// (`story-contract.ts:plotlinesHandoffRefusal` / `plotlinesCustomStartRefusal`), and prints the half of the fact
// the Author was missing (`plotlinesCustomStartNotice`): the arm is open, and the crew does not follow the start
// until phase ① is signed off (L-33).
// ---------------------------------------------------------------------------
describe('PlotlinesHandoff — the custom arm on a book with no compiled Summary (R7)', () => {
    it('opens the skip arm while the compiled arm stays shut, and says which is which', () => {
        const { actions, calls } = fixtureActions();
        const view = handoffView({ compiled: false });

        render(<PlotlinesHandoff view={view} actions={actions} />);

        // THE ARM IS OPEN — the button the fix is about. Enabled, and its `title` says what it does rather than
        // borrowing the compiled arm's refusal.
        const custom = screen.getByTestId('plotlines-handoff-custom-open');

        expect(custom.hasAttribute('disabled')).toBe(false);
        expect(custom.getAttribute('title')).toBe(
            'Start Phrase 2 on a Seed you write here, instead of the compiled Summary — no compiled Summary is needed for this arm.'
        );

        // THE COMPILED ARM IS STILL SHUT, with its own sentence in both places U-16 requires (the `title`, and the
        // line under the card that names WHERE the wait is). The fix moved a gate; it did not soften a refusal.
        const compiled = screen.getByTestId('plotlines-handoff-compiled');

        expect(compiled.hasAttribute('disabled')).toBe(true);
        expect(compiled.getAttribute('title')).toBe(
            'There is no compiled Summary to start Phrase 2 from yet — the Overview (or the reviewed Summary) is the text the phrase copies, so the gate is above this control (R5).'
        );
        expect(screen.getByTestId('plotlines-handoff-refusal').textContent).toBe(
            'There is no compiled Summary to start Phrase 2 from yet — the Overview (or the reviewed Summary) is the text the phrase copies, so the gate is above this control (R5).'
        );

        // THE OTHER HALF OF THE FACT, printed beside the shut button: the card is not blocked, and the text the
        // Author writes here IS the Seed. Asserted as the contract module's own derivation too, so the pane cannot
        // quietly reword what `story-contract.test.ts` pins verbatim.
        const notice = screen.getByTestId('plotlines-handoff-custom-notice');

        expect(notice.textContent).toBe(
            'There is no compiled Summary to copy yet, so the compiled arm stays shut — “Start from your own brief” is open, ' +
                'and the text you write there is the Seed the phrase copies (the Start verb takes `source: custom` without a compiled Summary, R5 / D-76). ' +
                'This Summary is signed off, so starting Phrase 2 also moves the crew into Phase 2 (the pointer follows a start only when phase ① is locked, L-33).'
        );
        expect(notice.textContent).toBe(plotlinesCustomStartNotice(view, true));

        // A press on the open arm arms the form: the path the compiled gate used to block starts here.
        fireEvent.click(custom);

        expect(screen.getByTestId('plotlines-handoff-custom')).toBeTruthy();
        expect(calls.startPhrase).toBeUndefined();
    });

    it('starts Phrase 2 on the Author’s own text with nothing compiled, and the body names only that arm', () => {
        const { actions, calls } = fixtureActions();

        render(<PlotlinesHandoff view={handoffView({ compiled: false })} actions={actions} />);

        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-open'));
        fireEvent.change(screen.getByTestId('plotlines-handoff-custom-text'), {
            target: { value: '  six chapters, alternating timeline, no frame story  ' }
        });

        const submit = screen.getByTestId('plotlines-handoff-custom-submit');

        expect(submit.hasAttribute('disabled')).toBe(false);

        fireEvent.click(submit);

        // THE BODY, EXACTLY as the route reads it: one arm, trimmed text, and no `source:'compiled'` — the request
        // that used to be unreachable from this card, and the one `phrase-start-routes.test.ts` accepts with a 200
        // on a book that has no compiled Summary at all.
        expect(calls.startPhrase).toEqual([
            ['s1', 'plotlines', { source: 'custom', text: 'six chapters, alternating timeline, no frame story' }]
        ]);
    });

    it('prints neither sentence when the shell has no verb to open the form with (U-16)', () => {
        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: false })} />);

        // The card says WHICH route is missing, and renders no field whose only verb is that missing one.
        expect(screen.getByTestId('plotlines-handoff-refusal').textContent).toBe(
            'The phrase start route is not available in this shell.'
        );
        expect(container.querySelector('[data-testid="plotlines-handoff-custom-open"]')).toBeNull();
        // And the "the arm is open" notice is absent, because above this card it would be false: an explanation
        // that contradicts the screen is worse than the one sentence the Author does need.
        expect(container.querySelector('[data-testid="plotlines-handoff-custom-notice"]')).toBeNull();
    });

    it('stays shut on a started phrase, where both arms are refused with the D-72 sentence', () => {
        const { actions, calls } = fixtureActions();
        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: false, started: true })} actions={actions} />);

        // The receipt replaced the controls entirely — a live button here would promise a write the route refuses.
        expect(screen.getByTestId('plotlines-handoff-started').textContent).toBe('started');
        expect(container.querySelector('[data-testid="plotlines-handoff-custom-open"]')).toBeNull();
        expect(container.querySelector('[data-testid="plotlines-handoff-custom-notice"]')).toBeNull();

        fireEvent.click(screen.getByTestId('plotlines-handoff-open'));

        // The receipt's only verb is the navigation; nothing on a started book may send a start body.
        expect(calls.startPhrase).toBeUndefined();
    });
});

// R7 — THE PROOFREAD ARM, AT THE DESK. The route's own suite pins the proposal and its guards; what only THIS file
// can pin is the confirm's shape, which is the whole of AC2 and AC3:
//
//   · the ask carries the draft in the box, trimmed — the same bytes the Start would copy, so a proposal cannot be
//     about a text the desk never sends (the hash the answer carries is computed over exactly those bytes);
//   · a proposal changes NOTHING until the Author takes it, and taking it is not a write: the box holds the new
//     text and the next `source:'custom'` press is what records it (`StartPhraseRequest` grew no flag, so there is
//     no path by which the pass reaches the phrase on its own — D-72, D-76/§18.13);
//   · a guard refusal carries no `text`, so the card renders no proposal and no confirm control, and the Start
//     press goes out over the Author's own words — AC3's "silently confirmed" has no affordance to happen through;
//   · the proposal dies when the box changes, because it is a claim about the text the pass read.
describe('PlotlinesHandoff — the one-time Seed proofread (R7)', () => {
    // THE DRAFT, with the grammar still in it, and the answer the pass hands back: same sentences, the 6 intact,
    // nothing added. The two differ ONLY in inflection, so nothing in these tests hinges on a length guard.
    const BROKEN = 'A mapmaker she find her own coastline, and she need 6 charts.';
    const CLEAN = 'A mapmaker finds her own coastline, and she needs 6 charts.';

    /**
     * The ask, recorded. `fixtureActions`'s recorder is built into ITS stub, so replacing the member with a plain
     * `vi.fn` would leave `calls.requestSeedCleanup` empty no matter what the card did — the assertion below needs
     * the arguments the card actually sent, so the stand-in does the recording itself.
     */
    function recording(answer: SeedCleanupProposal | null) {
        const asked: unknown[][] = [];

        // Typed as the action itself, so the double cannot drift out of the proposal union, and so the ASSIGNMENT
        // below is provably the same three-argument shape the card's type names.
        const requestSeedCleanup = vi.fn(
            async (storyId: string, phraseKey: string, seed: string): Promise<SeedCleanupProposal | null> => {
                asked.push([storyId, phraseKey, seed]);

                return answer;
            }
        );

        return { asked, requestSeedCleanup };
    }

    /**
     * The card, armed, with the draft typed — and the cleanup verb answering whatever the test asks. `null` is the
     * route's failure arm (400/404/409), which `state.ts` turns into the shell's line and the card turns into
     * nothing at all.
     */
    async function mountArmed(answer: SeedCleanupProposal | null) {
        const { actions, calls } = fixtureActions();
        const cleanup = recording(answer);

        actions.requestSeedCleanup = cleanup.requestSeedCleanup;

        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);

        await click(screen.getByTestId('plotlines-handoff-custom-open'));
        await type(screen.getByTestId('plotlines-handoff-custom-text'), BROKEN);

        return { actions, calls, container, asked: cleanup.asked };
    }

    /** The Seed box, read back as the value the next Start press would send. */
    function seedBox(): HTMLTextAreaElement {
        return screen.getByTestId('plotlines-handoff-custom-text') as HTMLTextAreaElement;
    }

    it('asks about the draft in the box, and about nothing else (AC2)', async () => {
        const { asked } = await mountArmed({ ok: true, source_hash: '9b8387ee', text: CLEAN, changed: true });

        await click(screen.getByTestId('plotlines-handoff-cleanup-ask'));

        // THE ARGUMENT LIST IS THE CLAIM: one read, Phrase ②, and the trimmed text from the box. A card that sent
        // the untrimmed draft would get a proofread of bytes the Start never copies.
        expect(asked).toEqual([['s1', 'plotlines', BROKEN]]);
        expect(screen.getByTestId('plotlines-handoff-cleanup-text').textContent).toBe(CLEAN);
        // THE SENTENCE THAT SAYS NOTHING HAS HAPPENED. Without it a highlighted suggestion reads as applied.
        expect(screen.getByTestId('plotlines-handoff-cleanup-note').textContent).toBe(SEED_CLEANUP_PROPOSAL_NOTE);
        // AND THE BOX IS UNTOUCHED until the Author says otherwise — the pass cannot rewrite a draft behind them.
        expect(seedBox().value).toBe(BROKEN);
    });

    it('takes the proposal into the box, and the next Start press carries exactly those bytes (AC2)', async () => {
        const { calls } = await mountArmed({ ok: true, source_hash: '9b8387ee', text: CLEAN, changed: true });

        await click(screen.getByTestId('plotlines-handoff-cleanup-ask'));
        await click(screen.getByTestId('plotlines-handoff-cleanup-confirm'));

        expect(seedBox().value).toBe(CLEAN);
        // TAKEN, NOT RECORDED — the line that stops "the box changed" from being read as "the desk wrote it".
        expect(screen.getByTestId('plotlines-handoff-cleanup-applied').textContent).toBe(SEED_CLEANUP_APPLIED_NOTE);
        // One confirm control, and it is gone now: the proposal cannot be taken twice, and a second press would
        // suggest there was still a write pending.
        expect(screen.queryByTestId('plotlines-handoff-cleanup-confirm')).toBeNull();

        await click(screen.getByTestId('plotlines-handoff-custom-submit'));

        // THE CONFIRM IS THE PRESS. One start, the custom arm, and the PROPOSAL's text — the Author's broken draft
        // is gone from the body because the Author moved the box, not because the pass reached the phrase.
        expect(calls.startPhrase).toEqual([['s1', 'plotlines', { source: 'custom', text: CLEAN }]]);
    });

    it('shows a guard refusal with no proposal and no confirm control, and starts on the Author’s words (AC3)', async () => {
        const { calls } = await mountArmed({ ok: false, source_hash: '9b8387ee', refusal: 'numbers_lost' });

        await click(screen.getByTestId('plotlines-handoff-cleanup-ask'));

        expect(screen.getByTestId('plotlines-handoff-cleanup-refusal').textContent).toBe(
            seedCleanupRefusalNotice('numbers_lost')
        );
        // NOTHING TO CONFIRM. A refusal that carried the source text in `text` would hand the Author their own
        // prose back as a suggestion, and the confirm below would "improve" the brief the guard just rejected.
        expect(screen.queryByTestId('plotlines-handoff-cleanup-text')).toBeNull();
        expect(screen.queryByTestId('plotlines-handoff-cleanup-confirm')).toBeNull();
        expect(screen.queryByTestId('plotlines-handoff-cleanup-note')).toBeNull();
        expect(seedBox().value).toBe(BROKEN);

        await click(screen.getByTestId('plotlines-handoff-custom-submit'));

        // THE SEED IS THE AUTHOR'S TEXT, guards and all — the refused cleanup changed nothing on the way out.
        expect(calls.startPhrase).toEqual([['s1', 'plotlines', { source: 'custom', text: BROKEN }]]);
    });

    it('says “nothing to fix” as the answer it is, with no suggestion to take', async () => {
        const { calls } = await mountArmed({ ok: true, source_hash: '9b8387ee', text: BROKEN, changed: false });

        await click(screen.getByTestId('plotlines-handoff-cleanup-ask'));

        expect(screen.getByTestId('plotlines-handoff-cleanup-clean').textContent).toBe(SEED_CLEANUP_NOTHING_TO_FIX);
        expect(screen.queryByTestId('plotlines-handoff-cleanup-confirm')).toBeNull();
        expect(seedBox().value).toBe(BROKEN);

        await click(screen.getByTestId('plotlines-handoff-custom-submit'));

        expect(calls.startPhrase).toEqual([['s1', 'plotlines', { source: 'custom', text: BROKEN }]]);
    });

    it('retires the proposal the moment the draft changes — it is a claim about the text the pass read', async () => {
        const { asked } = await mountArmed({ ok: true, source_hash: '9b8387ee', text: CLEAN, changed: true });

        await click(screen.getByTestId('plotlines-handoff-cleanup-ask'));

        expect(screen.getByTestId('plotlines-handoff-cleanup-text').textContent).toBe(CLEAN);

        await type(seedBox(), `${BROKEN} The harbour master keeps a lighthouse.`);

        // GONE, not greyed: `source_hash` hashes the draft the pass read, so it cannot bind this proposal to the
        // edited bytes, and a confirm here would paste a correction of a sentence nobody sent.
        expect(screen.queryByTestId('plotlines-handoff-cleanup-text')).toBeNull();
        expect(screen.queryByTestId('plotlines-handoff-cleanup-note')).toBeNull();
        // AND THE ASK IS LIVE AGAIN, which is the recovery: one press and the Editor is reading what is in the box.
        expect((screen.getByTestId('plotlines-handoff-cleanup-ask') as HTMLButtonElement).disabled).toBe(false);

        await click(screen.getByTestId('plotlines-handoff-cleanup-ask'));

        expect(asked).toEqual([
            ['s1', 'plotlines', BROKEN],
            ['s1', 'plotlines', `${BROKEN} The harbour master keeps a lighthouse.`]
        ]);
    });

    it('shuts the ask while the box is empty, and names the reason (U-16)', async () => {
        const { actions, calls } = fixtureActions();

        // A SPY, not `fixtureActions`' stub: the claim is that the verb was never DIALED, and a recorder the card
        // replaced cannot answer that.
        const asked = vi.fn(async (): Promise<SeedCleanupProposal> => ({
            ok: true,
            source_hash: '9b8387ee',
            text: CLEAN,
            changed: true
        }));

        actions.requestSeedCleanup = asked;

        render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);
        await click(screen.getByTestId('plotlines-handoff-custom-open'));

        const ask = screen.getByTestId('plotlines-handoff-cleanup-ask') as HTMLButtonElement;

        expect(ask.disabled).toBe(true);
        expect(ask.title).toBe(seedCleanupAskRefusal('', true));

        await click(ask);

        // A blank draft never reaches the provider: the route 400s rather than spend a call on an answer it knows,
        // and the card does not even dial. `calls.requestSeedCleanup` stays undefined for the same reason the spy
        // stays empty — the recorder belongs to the stub the card is not using.
        expect(asked).toHaveBeenCalledTimes(0);
        expect(calls.requestSeedCleanup).toBeUndefined();
    });

    it('renders no proofread control at all in a shell that has no such route (U-16)', async () => {
        const { actions, calls } = fixtureActions();

        // THE VERB IS ABSENT, not merely failing: an optional action means the shell has no route to answer it.
        delete (actions as Partial<typeof actions>).requestSeedCleanup;

        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);

        await click(screen.getByTestId('plotlines-handoff-custom-open'));
        await type(screen.getByTestId('plotlines-handoff-custom-text'), BROKEN);

        expect(container.querySelector('[data-testid="plotlines-handoff-cleanup"]')).toBeNull();
        // The Start path is untouched by the missing affordance: an Author with no Editor still starts.
        await click(screen.getByTestId('plotlines-handoff-custom-submit'));
        expect(calls.startPhrase).toEqual([['s1', 'plotlines', { source: 'custom', text: BROKEN }]]);
    });

    it('shows no proposal when the read itself failed — the sentence belongs to the shell’s line (L-13)', async () => {
        const { asked } = await mountArmed(null);

        await click(screen.getByTestId('plotlines-handoff-cleanup-ask'));

        // NEITHER arm of a proposal, and no refusal either: the 409's sentence is the shell's to print, and a second
        // copy inside the card would be the same failure described twice, differently worded.
        expect(screen.queryByTestId('plotlines-handoff-cleanup-text')).toBeNull();
        expect(screen.queryByTestId('plotlines-handoff-cleanup-refusal')).toBeNull();
        expect(screen.queryByTestId('plotlines-handoff-cleanup-clean')).toBeNull();
        expect(screen.queryByTestId('plotlines-handoff-cleanup-note')).toBeNull();
        // THE ASK DID GO OUT, once — and its arguments are the box's text, failure or not.
        expect(asked).toEqual([['s1', 'plotlines', BROKEN]]);
        // The Author can simply press it again — a failed read is not a spent one.
        expect((screen.getByTestId('plotlines-handoff-cleanup-ask') as HTMLButtonElement).disabled).toBe(false);
    });
});
