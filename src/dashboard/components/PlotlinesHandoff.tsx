// T-W4 — THE HANDOFF: the Author's one verb that turns the finished Summary into Phrase ②'s Seed.
//
// WHY THIS CARD EXISTS AT ALL (R5 / D-76). A phrase is not a pane you can simply open: Phrase ② is WRITTEN from a
// Seed, and the Seed is a copy of this Story's compiled Summary. Before this control existed, nothing in the desk
// made that step — the rail had no Phrase ②, `phrase_started.plotlines` stayed false forever, and the chapter
// entries the loop can produce had no way to be born. The card is the step: one press copies the Overview the crew
// stands behind, the projection flips `phrase_started.plotlines`, and the rail's Phrase 2 row gains its entries.
//
// WHY THE BUTTON IS ENABLED BY `story.summary_compiled` AND NOT BY A CLIENT-SIDE GUESS. The projection computes that
// flag from `projections.ts:compiledSummaryOf` — the SAME read the start route copies its Seed from (the complete
// reviewed Overview when the crew produced one, else the Overview as it stands). So a disabled button and a start
// that would have been accepted are one fact, and the desk never re-derives "is the Summary compiled" from the group
// rows it happens to be holding (L-14). The refusal sentence comes from `story-contract.plotlinesHandoffRefusal`,
// which states the same three states in the order the Author meets them.
//
// WHY THERE IS ALSO A CUSTOM-SEED ARM. The compiled Overview is the DEFAULT, not a law: an Author who already knows
// the shape they want ("six chapters, alternating timeline, no frame story") can start the phrase on that text
// instead. It is deliberately the MINIMAL form — one field, no wizard — because the request was for a skip, not a
// planning tool: the phrase's own brief is where the structure gets argued, and that is the Editor's work. The arm
// is reached by a second click (`Start from your own brief` → a field), so the one-press path stays the default.
//
// WHY THE STARTED STATE IS SHOWN INSTEAD OF A DEAD BUTTON. The start is one-way: the copied Seed is what every
// entry, revision and claim key was written against, so a second start is a 409 (D-72). A control that stays on
// screen only to be refused would be a lie about what the desk can do; the card says the phrase started, names the
// text it started from, and links to the surface that opened.
import { useState } from 'react';
import { PHRASE_PLOTLINES_KEY } from '../api';
import { MarkdownText } from './MarkdownText';
import {
    customSeedRefusal,
    plotlinesHandoffRefusal,
    plotlinesStarted,
    summaryIsCompiled,
    type StoryActions,
    type StoryViewData
} from './story-contract';
import type { StorySelection } from './story-nav';

export interface PlotlinesHandoffProps {
    view: StoryViewData;
    /** The pinned action surface; an absent `startPhrase` says so on the control (U-16). */
    actions?: StoryActions;
    onSelect?: (selection: StorySelection) => void;
}

/**
 * The handoff card, in its three states: live (press to start), armed (the two arms), and started (the receipt).
 *
 * It renders NOTHING for a book that is not on the Summary surface's decision path — `StoryView` keeps that gate —
 * so the card never haunts a chapter-entry pane or a classic Plotlines book with a verb it cannot use.
 */
export function PlotlinesHandoff({ view, actions = {}, onSelect }: PlotlinesHandoffProps) {
    // Local state, all of it about a WRITE IN PROGRESS and none of it about the record (P1):
    //   - `armed` is the second click that reveals the custom-seed arm;
    //   - `seed` is the Author's pending text, dropped on send like every other draft in this package, so what
    //     appears next is the server's answer rather than a half-remembered request.
    const [armed, setArmed] = useState(false);
    const [seed, setSeed] = useState('');

    const started = plotlinesStarted(view);
    const compiled = summaryIsCompiled(view);
    // U-16: a shut control states its reason, and the reason is the wire's own state or the shell's missing verb.
    const refusal = plotlinesHandoffRefusal(view, actions.startPhrase !== undefined);
    const canStart = refusal === '';
    const seedRefusal = customSeedRefusal(seed);
    const canStartCustom = actions.startPhrase !== undefined && seedRefusal === '';

    /** The default arm: the route copies this Story's compiled Summary (`{source:'compiled'}`). */
    const startCompiled = () => {
        if (!canStart) {
            return;
        }

        setArmed(false);
        setSeed('');
        void actions.startPhrase?.(view.story.id, PHRASE_PLOTLINES_KEY, { source: 'compiled' });
    };

    /** The skip arm: the route copies what the Author typed (`{source:'custom', text}`). */
    const startCustom = () => {
        if (!canStartCustom) {
            return;
        }

        setArmed(false);
        setSeed('');
        void actions.startPhrase?.(view.story.id, PHRASE_PLOTLINES_KEY, { source: 'custom', text: seed.trim() });
    };

    if (started) {
        // THE RECEIPT. It reports the phrase's own read when the desk is holding one (`seed_head`/`seed_chars` are
        // the projection's fields, read back off the phrase row after the commit), so the sentence and the rail
        // describe one copied Seed; with no read in the frame yet it keeps to the flag it does have.
        const head = view.phraseDetail?.seed_head;
        const chars = view.phraseDetail?.seed_chars;

        return (
            <div className="sv-pane sv-plotlines-handoff" data-testid="plotlines-handoff">
                <div className="sv-pane-head">
                    <h3 className="sv-pane-title">Phrase 2 — Plotlines</h3>
                    <span className="sv-pane-badge" data-testid="plotlines-handoff-started">
                        started
                    </span>
                </div>
                <p className="sv-pane-subtitle" data-testid="plotlines-handoff-seed">
                    {chars === undefined || head === undefined
                        ? 'Phrase 2 has started on this Story: its Seed is copied, and every chapter entry, revision and claim key is written against it (D-72).'
                        : `Phrase 2 has started on this Story. Its Seed is ${chars} characters of the Summary the crew compiled, and every chapter entry, revision and claim key is written against it (D-72).`}
                </p>
                {/* The head is a READING copy, not a summary: the projection sends a 400-character prefix
                   (`projections.ts:2016` `seed_head: seed.slice(0, SEED_HEAD_CHARS)`), and the Author recognising
                   which text the phrase was started from is the fact the field exists for.

                   WHY IT IS RENDERED AS MARKDOWN. That prefix is a slice of the compiled Overview, and the Overview is
                   `shared/phrase.ts:composePhraseContent` output — `## <group>\n<content>` joined — so a compiled head
                   OPENS on `## Premise` (`phrase-start-routes.test.ts:556` shows exactly that string on the wire).
                   Printed, the Author reads the source of the text they already chose; rendered, they read the text.
                   A custom-seed head (the skip arm) is the Author's own prose, and one paragraph of it renders
                   unchanged, so both arms benefit and neither is hurt. `MarkdownText` is the same renderer the
                   Summary card uses (`SummaryOverviewPane.tsx:404`), and `className="sv-summary-text"` keeps both
                   existing hooks on the ONE wrapper: the sizing rule (`styles/story.css:475-480`) and `data-testid`.
                   The stylesheet already carries the markdown case of that class —
                   `.sv-summary-text.sv-markdown { white-space: normal }` (`styles/story.css:513-517`) — which is what
                   stops react-markdown's newline text nodes between blocks printing as extra blank lines under the
                   base rule's `pre-wrap`.

                   THE TRUNCATION HAZARD, AND WHY IT DOES NOT VETO RENDERING. The head is a CHARACTER slice, so it can
                   end mid-`**bold`, mid-`` `code ``, mid-fence, or right after a `## ` with no body. Each case was
                   probed and is pinned in `PlotlinesHandoff.test.tsx`: an unmatched `**` or backtick stays literal
                   text (CommonMark, not a structure), a `## ` cut before its body is still an `<h2>`, and an
                   unterminated ``` fence auto-closes at end of document, so what it swallows is the HEAD's own
                   remainder — never the card. `MarkdownText` renders only this string inside its own `<div>`, so no
                   sibling UI can be pulled into the code block; the swallowed text is still on screen, just on the
                   fenced-code surface (`.sv-markdown pre` in `styles/story.css`). The one residue is a LATER
                   group title that falls inside a dangling fence, which prints its `## ` as code text — the first
                   `## Premise` can never be affected, because the slice starts at the seed's start and a fence can
                   only open after it. Making the slice markdown-safe (trimming to the last block boundary) would
                   change a projection field every receipt consumer reads back for a cosmetic edge, so the minimal
                   defensible option is to render and to pin the behaviour in tests. */}
                {head === undefined || head === '' ? null : (
                    <MarkdownText className="sv-summary-text" testId="plotlines-handoff-seed-head">
                        {head}
                    </MarkdownText>
                )}
                <div className="sv-summary-actions">
                    <button
                        type="button"
                        data-testid="plotlines-handoff-open"
                        onClick={() => onSelect?.({ panel: 'plotlines' })}
                    >
                        Open Phrase 2
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="sv-pane sv-plotlines-handoff" data-testid="plotlines-handoff">
            <div className="sv-pane-head">
                <h3 className="sv-pane-title">Phrase 2 — Plotlines</h3>
                <span
                    className="sv-pane-badge"
                    data-tone={compiled ? 'ready' : 'pending'}
                    data-testid="plotlines-handoff-state"
                >
                    {compiled ? 'ready to start' : 'waiting on the Summary'}
                </span>
            </div>
            <p className="sv-pane-subtitle">
                Starting Phrase 2 copies this Summary into the phrase as its Seed — the text the Editor structures
                into chapters, and the one text every chapter entry, revision and claim key is written against from
                here on. The start is not repeatable (D-72).
            </p>
            {/* U-16 in the control itself: the reason rides the `title`, and when the gate is above this card the
                sentence also sits under it, because a disabled button alone does not tell the Author WHERE the wait
                is. The refusal is the contract module's, verbatim (L-13). */}
            <div className="sv-reviewed-actions">
                <button
                    type="button"
                    className="sv-plotlines-handoff-button"
                    data-testid="plotlines-handoff-compiled"
                    disabled={!canStart || armed}
                    // U-16: the reason a shut control is shut rides the `title`. Armed is the card's OWN state
                    // (the other arm is open), so it says that rather than repeating the R5 sentence above a
                    // button the Author cannot press.
                    title={
                        canStart
                            ? armed
                                ? 'The custom Seed form is open — “Keep the compiled Summary” closes it.'
                                : 'Start Phrase 2 from the compiled Summary — the Overview is copied into the phrase as its Seed (R5).'
                            : refusal
                    }
                    onClick={startCompiled}
                >
                    Start Phrase 2 from the compiled Summary
                </button>
                {/* The skip arm is shut for the SAME reason the compiled arm is: with nothing compiled there is no
                    Overview to compare against, and the arm is about replacing that text, not inventing a second
                    one. Once the compiled arm is armed the form is open, so this button goes away with it. */}
                {actions.startPhrase === undefined || armed ? null : (
                    <button
                        type="button"
                        className="button button--ghost"
                        data-testid="plotlines-handoff-custom-open"
                        disabled={!canStart}
                        title={canStart ? 'Start Phrase 2 on a Seed you write here, instead of the compiled Summary.' : refusal}
                        onClick={() => setArmed(true)}
                    >
                        Start from your own brief
                    </button>
                )}
            </div>
            {canStart || armed ? null : (
                <p className="sv-group-notice sv-group-notice--warn" data-testid="plotlines-handoff-refusal">
                    {refusal}
                </p>
            )}

            {armed ? (
                /* THE SKIP FORM. One field and one verb: the phrase's own brief is where the chapter structure gets
                   argued (the Editor's work), so the form asks only for the text to copy. The optional-field rule
                   the rest of this package follows applies to the START BODY, not the form: `api.ts:startPhrase`
                   sends `{source:'custom', text}` and never a stray `text` beside `'compiled'`, because the route
                   reads exactly one arm per request. */
                <div className="sv-reviewed-confirm" data-testid="plotlines-handoff-custom">
                    <p className="sv-group-notice" data-testid="plotlines-handoff-custom-note">
                        What you write here becomes the Seed instead of the compiled Summary. The Editor
                        structures it into chapters exactly as it does the Overview, and the start is still
                        one-way (D-72).
                    </p>
                    <textarea
                        className="sv-summary-field"
                        data-testid="plotlines-handoff-custom-text"
                        rows={5}
                        value={seed}
                        placeholder="the chapter plan you want Phrase 2 built from — e.g. six chapters, alternating timeline, no frame story"
                        onChange={(event) => setSeed(event.target.value)}
                    />
                    <div className="sv-summary-actions">
                        <button
                            type="button"
                            data-testid="plotlines-handoff-custom-submit"
                            disabled={!canStartCustom}
                            title={canStartCustom ? 'Start Phrase 2 on this text.' : seedRefusal}
                            onClick={startCustom}
                        >
                            Start Phrase 2 from this Seed
                        </button>
                        <button
                            type="button"
                            data-testid="plotlines-handoff-custom-cancel"
                            onClick={() => {
                                setArmed(false);
                                setSeed('');
                            }}
                        >
                            Keep the compiled Summary
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

export default PlotlinesHandoff;
