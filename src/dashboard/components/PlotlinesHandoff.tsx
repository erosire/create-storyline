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
// WHY THE CUSTOM ARM DOES NOT WAIT ON THE COMPILED SUMMARY (R7, this wave). It used to: the button carried the
// compiled arm's `disabled={!canStart}`, so an Author with a summary ready of their own could not type it until
// Phrase ① had produced an Overview. That was the DESK blocking a move the SERVER allows — `routes.ts` refuses a
// `custom` start with no text (400) and only then asks whether anything is compiled (the 409), so a non-empty
// `custom` text starts the phrase on a book whose Summary was never written. Each arm now answers to its own gate
// (`story-contract.plotlinesHandoffRefusal` for the compiled arm, `plotlinesCustomStartRefusal` for this one), and
// `plotlinesCustomStartNotice` says what the compiled arm is still waiting for and where the crew goes after the
// start — which is nowhere new: the pointer follows a start only once phase ① is signed off (L-33).
//
// WHY THE STARTED STATE IS SHOWN INSTEAD OF A DEAD BUTTON. The start is one-way: the copied Seed is what every
// entry, revision and claim key was written against, so a second start is a 409 (D-72). A control that stays on
// screen only to be refused would be a lie about what the desk can do; the card says the phrase started, names the
// text it started from, and links to the surface that opened.
//
// WHY THE PROOFREAD IS A SUGGESTION AND NOT A REWRITE (R7, this wave). The armed arm offers one extra read: the
// Editor may look over the draft in the box and hand back the same brief with its grammar corrected. THREE THINGS
// THAT DO NOT HAPPEN, and the card is the only place any of them is visible:
//   - nothing is written. The verb is a GET (`api.ts:getPhraseSeedCleanup`) over a Seed that has no row yet — the
//     Start copies it (D-72) — so the pass has no record to leave behind, and ignoring it costs one model turn
//     (P10);
//   - nothing is applied. "Use this text" only moves the text into the box; the box is what the next Start press
//     copies, so the CONFIRM IS THAT PRESS and `PhraseStartInput` grew no flag. There is no path by which a
//     proposal reaches the phrase without an Author pressing Start, which is what AC3 asks for;
//   - a guard refusal is not a failure and carries no text. `empty_answer` / `numbers_lost` / `too_short` /
//     `too_long` mean the model answered and a rule threw the rewrite away, so there is NOTHING to confirm and the
//     Author's own draft stands — printed inline (L-13), not as the shell's error strip.
//
// WHY THE PROPOSAL DIES THE MOMENT THE BOX CHANGES. `source_hash` is the pass's hash of the DRAFT it read, not of
// its own answer, so it cannot bind a proposal to a later edit. Dropping the proposal on `onChange` is the honest
// rule: an Author who edits after reading the suggestion is asking a different question (and the button is one
// press away).
//
// WHY THE PROPOSAL IS COMPONENT STATE AND NOT A SLICE OF THE STORE. It is not a record (nothing on the server
// holds it), it belongs to one control, and it has to die with the draft it describes. Putting it in
// `state.ts`'s snapshot would need a keyed frame slot, and the frame would have to thread a new field through
// `StoryView.tsx` for a fact that is gone as soon as a key is pressed. The store's only job here is the transport:
// `state.ts:requestSeedCleanup` runs the read, clears or commits the shell's error line, and hands the proposal
// back to this card.
import { useRef, useState } from 'react';
import { PHRASE_PLOTLINES_KEY, type SeedCleanupProposal } from '../api';
import { MarkdownText } from './MarkdownText';
import {
    customSeedRefusal,
    plotlinesCustomStartNotice,
    plotlinesCustomStartRefusal,
    plotlinesHandoffRefusal,
    plotlinesSeedOrigin,
    plotlinesStarted,
    SEED_CLEANUP_APPLIED_NOTE,
    SEED_CLEANUP_NOTHING_TO_FIX,
    SEED_CLEANUP_PROPOSAL_NOTE,
    seedCleanupAskRefusal,
    seedCleanupRefusalNotice,
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
 * R7 — THE PROPOSAL THIS CARD IS HOLDING, and whether the Author has moved it into the box yet.
 *
 * `applied` is a FACT ABOUT THE BOX, not about the pass: the same proposal reads one way while it sits beside the
 * draft ("here is what the Editor suggests") and another way once it IS the draft ("this is what your next press
 * will copy"). Folding the two states together is how a suggestion becomes an assumed write, which is exactly the
 * reading AC3 exists to prevent.
 */
type SeedCleanupState = { proposal: SeedCleanupProposal; applied: boolean } | null;

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
    // R7 — the proofread's two pieces of state. `cleanup` is the proposal plus whether it is in the box; `asking`
    // is the read in flight, which the button has to say out loud because a model turn is the slowest thing this
    // card can start and a silent second press would ask the provider twice.
    const [cleanup, setCleanup] = useState<SeedCleanupState>(null);
    const [asking, setAsking] = useState(false);
    // R7 — THE BOX'S CURRENT TEXT, mirrored into a ref so a proposal that arrives LATE can be compared with the
    // draft it would land on (`askCleanup`). Assigning on every render is the whole trick: the closure that resumes
    // after the `await` reads the live value instead of the one it captured, which is what lets a stale answer be
    // dropped rather than shown over text the Editor never read.
    const draft = useRef(seed);

    draft.current = seed;

    const started = plotlinesStarted(view);
    const compiled = summaryIsCompiled(view);
    // U-16: a shut control states its reason, and the reason is the wire's own state or the shell's missing verb.
    const refusal = plotlinesHandoffRefusal(view, actions.startPhrase !== undefined);
    const canStart = refusal === '';
    // THE ARM'S OWN GATE (R7): the custom arm answers to the missing verb and to a phrase that already started —
    // never to `summary_compiled`, which is the COMPILED arm's Seed problem rather than this one's (see the header).
    const customArmRefusal = plotlinesCustomStartRefusal(view, actions.startPhrase !== undefined);
    const canOpenCustom = customArmRefusal === '';
    // What the card says when one arm is shut and the other is not: `''` when both are live, and `''` when NEITHER
    // is (a line claiming the custom arm is open above a card that renders no button is U-16's lie).
    const armNotice = plotlinesCustomStartNotice(view, actions.startPhrase !== undefined);
    const seedRefusal = customSeedRefusal(seed);
    const canStartCustom = actions.startPhrase !== undefined && seedRefusal === '';
    // R7 — THE PROOFREAD'S OWN GATE, and it is not the Start's: the ask needs the shell to have the verb (U-16) and
    // the box to hold a draft (the route 400s a blank `seed` rather than spend a call on an answer it knows). It
    // does NOT need `summary_compiled` — the cleanup belongs to the arm whose Seed is already in the Author's hand.
    const cleanupRefusal = seedCleanupAskRefusal(seed, actions.requestSeedCleanup !== undefined);
    const canAskCleanup = cleanupRefusal === '';
    // WHAT THE CARD SHOWS UNDER THE BOX: the proposal the pass answered with, if any. The four states are rendered
    // apart in the JSX — a refusal answer, a "nothing to fix" answer, a proposal waiting to be taken, and a
    // proposal the Author has taken — and they are narrowed there rather than through a precomputed boolean, so
    // TypeScript keeps the `ok` arms apart instead of trusting a derived flag.
    const proposal = cleanup?.proposal;

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
        // THE PROPOSAL GOES WITH THE DRAFT (R7). The press below is the confirm: it carries the box's text, so the
        // suggestion has done its only job, and a proposal left on screen under a started phrase would be a
        // suggestion the Author can still "take" onto a Seed that can no longer move (D-72).
        setCleanup(null);
        void actions.startPhrase?.(view.story.id, PHRASE_PLOTLINES_KEY, { source: 'custom', text: seed.trim() });
    };

    /**
     * THE ASK (R7) — one tool-less model turn, no write, and the answer belongs to the box, not to the book.
     *
     * THE STALE-ANSWER GUARD IS THE PART THAT HAS TO BE HERE. The read is the slowest thing this card can start,
     * and while it is in flight the Author may keep typing, close the arm, or press Start — all of which change the
     * draft. The answer is about the text that was in the box when the ask was pressed, so it is dropped unless the
     * box still holds exactly that text. Without this line a late answer re-appears under a draft it never read,
     * and "Use this text" becomes a way to replace a brief the Editor never saw.
     */
    const askCleanup = async () => {
        if (!canAskCleanup || actions.requestSeedCleanup === undefined) {
            return;
        }

        const asked = draft.current;

        setAsking(true);
        // THE PREVIOUS ANSWER DIES WITH THE REQUEST, so two proposals are never on screen claiming the same draft.
        setCleanup(null);

        const answer = await actions.requestSeedCleanup(view.story.id, PHRASE_PLOTLINES_KEY, asked);

        setAsking(false);

        // `null` is the route's 400 / 404 / 409, whose sentence the shell is printing already
        // (`state.ts:requestSeedCleanup` commits it to the error line, L-13). The card shows nothing rather than a
        // second copy of the same sentence, and shows NO PROPOSAL, because there is none.
        if (answer === null || draft.current !== asked) {
            return;
        }

        // A GUARD REFUSAL LANDS IN THE SAME SLOT AS A PROPOSAL, and the two are rendered apart below (`ok`). It is
        // not an error and it has no `text`, so there is nothing here to confirm — AC3's rule, in one branch.
        setCleanup({ proposal: answer, applied: false });
    };

    /**
     * "Use this text" — the only thing a proposal can do, and it is not a write. The box is what the next Start
     * press copies, so taking the suggestion changes the draft and marks it APPLIED; recording it is still the
     * Author's press (R7 / D-72).
     */
    const applyCleanup = () => {
        if (cleanup === null || !cleanup.proposal.ok || !cleanup.proposal.changed) {
            return;
        }

        setSeed(cleanup.proposal.text);
        setCleanup({ proposal: cleanup.proposal, applied: true });
    };

    /**
     * Every keystroke retires the proposal (see the header): `source_hash` hashes the DRAFT the pass read, so it
     * cannot bind a proposal to bytes that arrived after it. Keeping the ask button reachable is the whole
     * recovery — one press, and the Editor is reading the text that is actually in the box.
     */
    const onSeedChange = (value: string) => {
        setSeed(value);
        setCleanup(null);
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
                        : // R12 — the clause naming WHERE the Seed came from reads off `seed_source` instead of
                          // asserting the compiled arm. The custom arm has existed since R5, and this sentence kept
                          // crediting the crew for a brief the Author typed; the field now says which it was, and an
                          // unrecorded origin is reported as unrecorded rather than guessed (`plotlinesSeedOrigin`).
                          `Phrase 2 has started on this Story. Its Seed is ${chars} characters of ${plotlinesSeedOrigin(view.phraseDetail?.seed_source)}, and every chapter entry, revision and claim key is written against it (D-72).`}
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
                {/* The skip arm answers to its OWN gate (R7). It used to inherit the compiled arm's
                    `disabled={!canStart}`, which read as "the Summary has to be compiled before you may write your
                    own brief" — a gate the Start verb does not have: with a non-empty `custom` text it never reaches
                    the empty-compiled 409. What still shuts it is the shell having no verb (the field could not be
                    submitted, U-16) and a phrase that already started (D-72). Once the compiled arm is armed the
                    form is open, so this button goes away with it. */}
                {actions.startPhrase === undefined || armed ? null : (
                    <button
                        type="button"
                        className="button button--ghost"
                        data-testid="plotlines-handoff-custom-open"
                        disabled={!canOpenCustom}
                        title={
                            canOpenCustom
                                ? 'Start Phrase 2 on a Seed you write here, instead of the compiled Summary — no compiled Summary is needed for this arm.'
                                : customArmRefusal
                        }
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
            {/* THE OTHER HALF OF A PARTLY-SHUT CARD (R7). The sentence above is the compiled arm's reason and stays
                true; this one is what the Author was missing when the card looked blocked but was not — the arm that
                IS open, and where the crew goes after this start (nowhere new: the pointer follows a start only once
                phase ① is signed off, L-33). It renders armed or not, because the crew fact matters most at the
                moment the Author is typing the Seed. */}
            {armNotice === '' ? null : (
                <p className="sv-group-notice" data-testid="plotlines-handoff-custom-notice">
                    {armNotice}
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
                        onChange={(event) => onSeedChange(event.target.value)}
                    />
                    {/* R7 — THE EDITOR'S PASS OVER THE DRAFT, between the text and the press that records it.
                       THE ORDER IS THE ARGUMENT: read it, then press Start. The control renders ONLY where the shell
                       has the verb (U-16 — an absent verb means no route to answer it, and a shut button that
                       nothing can answer is worse than no button here, because the Start path does not need it), and
                       it is never a gate on the Start: an Author who ignores the Editor starts on their own words.

                       WHY THE PROPOSAL IS PRINTED AS PLAIN TEXT. `MarkdownText` is right for the started card's
                       Seed head (a slice of the compiled Overview, whose `## <group>` headings are the document's
                       own — see the note above), and wrong here: this is a CANDIDATE SENTENCE, and rendering it as
                       a document would style a suggestion like a record. A `changed:false` or refusal answer is
                       prose ABOUT the draft, so it rides the notice class the rest of the card uses. */}
                    {actions.requestSeedCleanup === undefined ? null : (
                        <div className="sv-plotlines-seed-cleanup" data-testid="plotlines-handoff-cleanup">
                            <div className="sv-summary-actions">
                                <button
                                    type="button"
                                    className="button button--ghost"
                                    data-testid="plotlines-handoff-cleanup-ask"
                                    disabled={!canAskCleanup || asking}
                                    // U-16: a shut control says which fact shuts it — the empty box, the missing
                                    // verb, or the read that is already in flight.
                                    title={
                                        asking
                                            ? 'The Editor is reading your brief.'
                                            : canAskCleanup
                                              ? 'One look at the grammar, spelling and punctuation of the text above — nothing is written, and the Seed that gets copied is still whatever your Start press carries (R7).'
                                              : cleanupRefusal
                                    }
                                    onClick={() => void askCleanup()}
                                >
                                    {asking ? 'The Editor is reading…' : 'Ask the Editor to proofread this'}
                                </button>
                            </div>
                            {proposal === undefined ? null : !proposal.ok ? (
                                /* THE GUARD REFUSED, AND IT IS AN ANSWER (AC3). No `text`, so there is nothing to
                                   take; the sentence names which rule fired, and the draft in the box is still the
                                   Author's. Deliberately NOT the shell's error strip: the request succeeded. */
                                <p className="sv-group-notice" data-testid="plotlines-handoff-cleanup-refusal">
                                    {/* W4/R6 — `blocker` rides only on a refusal the SERVER caused, and the notice
                                        puts it first: the Author has to be told which file to open, not that their
                                        brief came back unreadable. */}
                                    {seedCleanupRefusalNotice(proposal.refusal, proposal.blocker)}
                                </p>
                            ) : !proposal.changed ? (
                                <p className="sv-group-notice" data-testid="plotlines-handoff-cleanup-clean">
                                    {SEED_CLEANUP_NOTHING_TO_FIX}
                                </p>
                            ) : cleanup?.applied === true ? (
                                /* TAKEN, NOT RECORDED. The box changed, so the card says plainly that nothing was
                                   written and which press does the writing — the reading an Author is most likely
                                   to get wrong after watching a box change on its own. */
                                <p className="sv-group-notice" data-testid="plotlines-handoff-cleanup-applied">
                                    {SEED_CLEANUP_APPLIED_NOTE}
                                </p>
                            ) : (
                                <>
                                    <p className="sv-group-notice" data-testid="plotlines-handoff-cleanup-note">
                                        {SEED_CLEANUP_PROPOSAL_NOTE}
                                    </p>
                                    <p
                                        className="sv-summary-field sv-plotlines-seed-proposal"
                                        data-testid="plotlines-handoff-cleanup-text"
                                    >
                                        {proposal.text}
                                    </p>
                                    <div className="sv-summary-actions">
                                        <button
                                            type="button"
                                            data-testid="plotlines-handoff-cleanup-confirm"
                                            // THE CONFIRM IS THE START PRESS. This button only moves text; the
                                            // `title` says so, because the natural reading of an accepted
                                            // suggestion everywhere else is "it has been applied".
                                            title="Puts the Editor’s text in the box above. Nothing is recorded until you press “Start Phrase 2 from this Seed” — that press copies the text in the box (R7 / D-72)."
                                            onClick={applyCleanup}
                                        >
                                            Use this text
                                        </button>
                                        <button
                                            type="button"
                                            className="button button--ghost"
                                            data-testid="plotlines-handoff-cleanup-dismiss"
                                            title="Throws the proposal away. Your wording stays in the box, and nothing is written (R7)."
                                            onClick={() => setCleanup(null)}
                                        >
                                            Keep my wording
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    )}
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
                                // R7 — the proposal is about the draft, and the draft is gone: closing the arm
                                // throws both away, so a suggestion cannot outlive the box it was written for.
                                setCleanup(null);
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
