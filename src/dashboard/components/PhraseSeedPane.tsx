// U-25 — A PHRASE'S OWN SEED: the text this phrase was started from, shown for THAT phrase.
//
// WHY THIS PANE EXISTS AT ALL. The rail used to offer one `Seed → "The Author's idea"` row above the phrases, and the
// Author's words are the reason it is gone: "The Seed (The Author's Idea) belongs to the Phrase 1 … Phrase 2 have
// different seed (which is really the compiled version of Phrase 1 used as seed, but Author can paste his own seed
// in). Each Phrase are discrete, separate from each other". A phrase's Seed is its own artifact — `phraseSeedOf`
// (`src/server/phrase/catalog.ts:245-251`) hands Phrase ① the Author's `story.idea` and Phrase ② the text its Start
// copied — so opening a phrase's Seed row opens THIS pane, and the one thing it must never do is print `story.idea`
// and let it read as Phrase ②'s Seed. It never reads `story.idea` at all.
//
// WHAT IS ON THE WIRE, AND WHAT IS NOT. `GET /stories/:id/phrases/:key` answers the phrase's copied Seed as
// `seed_head` (a 400-character PREFIX, `src/server/api/projections.ts:2016-2034` and `SEED_HEAD_CHARS`) plus
// `seed_chars` (the true length), mirrored client-side as `api.ts:PhraseDetailView`. THE FULL SEED IS NOT ON THE
// WIRE, and this pane does not pretend otherwise: it prints the prefix and says how long the text is. Provenance is
// worded from those same fields — the read carries no `seed_source`, and the planner's decision is not to add one —
// so the pane says what it knows: the text was copied once at Start, from the compiled Overview or from the Author's
// own words, and nothing re-seeds it afterwards (D-72).
//
// WHY THE START CHOICE IS HERE. For an unstarted Phrase ② there is no copied text yet, and the honest answer is the
// choice itself: the compiled Phrase ① Overview, or the Author's paste. This is the SAME verb the Summary's handoff
// card fires (`api.ts:startPhrase`, `{source:'compiled'}` / `{source:'custom', text}`) and the SAME sentences
// (`story-contract.plotlinesHandoffRefusal`, `story-contract.customSeedRefusal`), restated on the Seed's own pane —
// one rule per rule, no new route and no new control (`PlotlinesHandoff.tsx` stays where it is, on the Summary
// surface, because that is where the text being copied is on screen).
//
// WHY A STARTED PHRASE HAS NO CONTROL. D-72: the copied Seed is what every chapter entry, revision and claim key is
// written against, so a second start is a 409 and re-seeding would rewrite the phrase's history. The pane is
// read-only, and it says so instead of showing a button the Author cannot press (U-16).
//
// WHY AN ABSENT READ IS NOT ALWAYS A WAIT. The store asks for the Phrase ② read only while the Story's dial is on
// `groups` (`state.ts:phraseDetailWanted`, state.ts:358-359), so a started Phrase ② on the classic dial has no read
// in the frame and never will: `seed_head`/`seed_chars` are fields of the chapter-entry read, and that read is not
// requested for the §4.3 pipeline. The pane therefore says which of its three states an absent read is — on its way
// (the grouped dial), refused (the server's sentence in `phraseDetailError`), or never requested (this one) — because
// a waiting wording over the last state is a promise the desk cannot keep.
import { useState } from 'react';
import { PHRASE_PLOTLINES_KEY } from '../api';
import { MarkdownText } from './MarkdownText';
import {
    customSeedRefusal,
    // U6, one phrase down: the three answers about a phrase read are "landed", "on its way", "unread" — and the
    // server's own sentence is the actionable fact in the last case. The rail's lines use the same pair.
    phraseDetailReadError,
    phraseDetailReadLanded,
    // F1 — the dial question the store gates its Phrase ② fetch on (`state.ts:phraseDetailWanted`), read here from
    // the same wire fields so the pane never waits on a read this pipeline does not request.
    isPlotlinesGroups,
    plotlinesHandoffRefusal,
    plotlinesStarted,
    summaryIsCompiled,
    type StoryActions,
    type StoryViewData
} from './story-contract';
// The pane's own heading is the SHARED Seed title: `phraseSeedTitle` is the same call `story-nav.selectionTitle`
// makes for this selection, so the rail's row, the pane's heading and the content area's title are one function
// rather than three compositions of one name. The body lines still name the phrase alone (`phraseLabel`), because
// they talk about the phrase, not about the row the Author clicked.
import { phraseLabel, phraseSeedTitle } from './story-nav';
import type { StoryPhraseSpec } from './story-nav';

export interface PhraseSeedPaneProps {
    view: StoryViewData;
    /** The pinned action surface; an absent `startPhrase` says so on the control (U-16). */
    actions?: StoryActions;
    /** The phrase the rail opened, so the heading and the wording name it. */
    phrase: StoryPhraseSpec;
}

export function PhraseSeedPane({ view, actions = {}, phrase }: PhraseSeedPaneProps) {
    // Local state about a WRITE IN PROGRESS only, exactly as `PlotlinesHandoff` keeps it (P1): the paste arm, and the
    // Author's pending text, which is dropped on send so what appears next is the server's answer.
    const [armed, setArmed] = useState(false);
    const [seed, setSeed] = useState('');

    // TODAY ONLY PHRASE ② HAS A COPIED SEED TO SHOW. A phrase's Seed comes from that phrase's read, and `state.ts`
    // fetches the read for `plotlines` alone (`phraseDetailWanted`, U-20); the desk has no start verb, and so no
    // copied Seed, for any other phrase. The rail therefore renders this pane for Phrase ②'s row and would render
    // the honest notice below for a phrase the loop cannot start yet.
    const copyable = phrase.key === PHRASE_PLOTLINES_KEY;
    const started = copyable && plotlinesStarted(view);
    // The phrase's OWN read — `phraseDetail`, never `view.phrase`, which is Phrase ①'s surface.
    const detail = copyable ? (view.phraseDetail ?? undefined) : undefined;
    const landed = copyable && phraseDetailReadLanded(view);
    const readError = copyable ? phraseDetailReadError(view) : undefined;
    const compiled = summaryIsCompiled(view);
    // IS A PHRASE READ EVEN COMING FOR THIS BOOK? An absent `phraseDetail` is THREE different states, and only one
    // of them is a wait: the read failed (`readError`, printed below from the server's own sentence), the read is in
    // flight, or the desk will NEVER ask for it. `state.ts:phraseDetailWanted` (state.ts:358-359) requests Phrase ②'s
    // read only while `storyViews[story].plotlines_mode === 'groups'` or the read is already cached, so a started
    // Phrase ② on the classic dial has no read to wait for and must not print a waiting wording. The two wire fields
    // the store's gate is computed from are checked here in the same order the projection sends them — the payload's
    // echoed `plotlines_mode` (the field `state.ts` reads) and `isPlotlinesGroups`, which also answers from the read's
    // own `mode` once it has landed — so the pane and the store cannot disagree about whether text is on its way.
    const readWanted = copyable && (view.plotlines_mode === 'groups' || isPlotlinesGroups(view));

    const title = `${phraseLabel(phrase)} · Seed`;
    const refusal = copyable ? plotlinesHandoffRefusal(view, actions.startPhrase !== undefined) : '';
    const canStart = refusal === '';
    const seedRefusal = customSeedRefusal(seed);
    const canStartCustom = actions.startPhrase !== undefined && seedRefusal === '';

    /** The default arm: the route copies the compiled Summary (`{source:'compiled'}`). */
    const startCompiled = () => {
        if (!canStart) return;

        setArmed(false);
        setSeed('');
        void actions.startPhrase?.(view.story.id, phrase.key, { source: 'compiled' });
    };

    /** The paste arm: the route copies what the Author typed (`{source:'custom', text}`). */
    const startCustom = () => {
        if (!canStartCustom) return;

        setArmed(false);
        setSeed('');
        void actions.startPhrase?.(view.story.id, phrase.key, { source: 'custom', text: seed.trim() });
    };

    return (
        <section className="sv-pane sv-phrase-seed-pane" aria-label={title} data-testid="phrase-seed-pane">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">{title}</h3>
                {/* The same three states the handoff card prints, in the same words, so the two surfaces cannot
                    describe one phrase differently: `started`, `ready to start`, `waiting on the Summary`. */}
                {!copyable ? (
                    // The same state slot as the two states below, so a test and the stylesheet both address the
                    // header's one line rather than a badge that only exists for this branch.
                    <span className="sv-pane-badge" data-tone="pending" data-testid="phrase-seed-state">
                        no Seed copied yet
                    </span>
                ) : started ? (
                    <span className="sv-pane-badge" data-testid="phrase-seed-state" data-tone="ready">
                        started
                    </span>
                ) : (
                    <span
                        className="sv-pane-badge"
                        data-tone={compiled ? 'ready' : 'pending'}
                        data-testid="phrase-seed-state"
                    >
                        {compiled ? 'ready to start' : 'waiting on the Summary'}
                    </span>
                )}
            </header>

            {!copyable ? (
                // A phrase the desk has no read for prints its absence rather than a borrowed text. Phrase ①'s idea
                // is NOT this phrase's Seed, and printing it here is the exact defect this requirement retires.
                <p className="sv-pane-subtitle" data-testid="phrase-seed-unavailable">
                    {`This phrase has no Seed on the wire: the desk reads a phrase’s Seed from its own phrase read, and the only phrase the platform starts with a copied Seed is Phrase 2 (U-20).`}
                </p>
            ) : started ? (
                <>
                    {/* STARTED, READ-ONLY. `seed_chars` and `seed_head` are the projection's own fields, so the
                        sentence and the rail's `started` mark describe one copied text. The provenance is stated as
                        what the wire supports: copied ONCE at Start, from the compiled Overview or from the Author's
                        words — the read carries no source field, so the pane names both arms instead of guessing one
                        (and `PlotlinesHandoff`'s receipt words it the same way from the same fields). */}
                    <p className="sv-pane-subtitle" data-testid="phrase-seed-chars">
                        {detail === undefined
                            ? `${phraseLabel(phrase)} has started on this Story: its Seed is copied, and every chapter entry, revision and claim key is written against it (D-72).`
                            : `${phraseLabel(phrase)} started on its own Seed: these ${detail.seed_chars} characters, copied once at Start — the compiled Phrase 1 Overview, or the words you typed instead.`}
                    </p>
                    {/* The three answers about the phrase read (U6, one phrase down): the text arrived, it is on its
                        way, or it could not be read — and the server's sentence is the fact in the last case. */}
                    {/* The answers about the phrase read (U6, one phrase down): the text arrived, it is on its way,
                        it could not be read, or — the classic dial's case — no read is coming for this book at all.
                        The last two are DIFFERENT sentences: the store's own gate (`state.ts:phraseDetailWanted`)
                        never requests the rows on that dial, so a waiting wording there is a promise the desk will
                        not keep. */}
                    {!landed || detail === undefined ? (
                        readError === undefined ? (
                            readWanted ? (
                                <p className="sv-group-notice" data-testid="phrase-seed-pending">
                                    reading this phrase’s Seed…
                                </p>
                            ) : (
                                <p className="sv-group-notice" data-testid="phrase-seed-no-read">
                                    {`This phrase started on the classic Plotlines pipeline: the desk reads a phrase’s copied Seed from that phrase’s chapter-entry read (U-20), and this dial never asks for it, so the text the Start copied stays on the server. The started mark above is the Story row’s, not a read’s, and nothing here is waiting.`}
                                </p>
                            )
                        ) : (
                            <p
                                className="sv-group-notice sv-group-notice--warn"
                                data-testid="phrase-seed-error"
                                title={readError}
                            >
                                {`This phrase’s Seed is unread: ${readError}`}
                            </p>
                        )
                    ) : (
                        // U-23 — the copied Seed IS markdown (it is the compiled Overview's bytes), so the reading
                        // copy renders through the one markdown renderer rather than printing `## Premise`. It is a
                        // 400-character prefix, so it can end mid-token; `PlotlinesHandoff.test.tsx` pins what each
                        // truncation does, and the residue stays on screen either way.
                        <MarkdownText className="sv-summary-text sv-phrase-seed-head" testId="phrase-seed-head">
                            {detail.seed_head}
                        </MarkdownText>
                    )}
                    {/* D-72 as a sentence, not a dead button: the phrase cannot be re-seeded, so the pane states the
                        rule where the Author would otherwise look for the control (U-16). */}
                    <p className="sv-group-notice" data-testid="phrase-seed-oneway">
                        Read-only, and there is nothing here to re-seed it: a new Seed means a new Story rather than a
                        new start (D-72).
                    </p>
                </>
            ) : (
                <>
                    {/* NOT YET STARTED. The Seed does not exist until the Author starts the phrase, and what it WILL
                        be is the one fact worth saying: the compiled Phrase ① Overview, unless the Author writes
                        their own. Same sentence the handoff card carries, phrased for a pane that is not standing on
                        the Summary. */}
                    <p className="sv-pane-subtitle" data-testid="phrase-seed-note">
                        {`${phraseLabel(phrase)} has no Seed yet. Starting it copies the compiled Phrase 1 Overview into the phrase as that phrase’s own Seed — the text the Editor structures into chapters, and the one text every chapter entry, revision and claim key is written against from here on. You can write the Seed yourself instead. The start is not repeatable (D-72).`}
                    </p>
                    {/* U-16: the reason a shut control is shut rides the `title`, and the contract module's own
                        sentence sits under the buttons when the gate is above them (L-13 — the refusal is the
                        server's reason, not one invented here). */}
                    <div className="sv-reviewed-actions">
                        <button
                            type="button"
                            className="sv-plotlines-handoff-button"
                            data-testid="phrase-seed-compiled"
                            disabled={!canStart || armed}
                            title={
                                canStart
                                    ? armed
                                        ? 'The custom Seed form is open — “Keep the compiled Summary” closes it.'
                                        : 'Start this phrase from the compiled Summary — the Overview is copied into the phrase as its Seed (R5).'
                                    : refusal
                            }
                            onClick={startCompiled}
                        >
                            {`Start ${phrase.title} from the compiled Summary`}
                        </button>
                        {actions.startPhrase === undefined || armed ? null : (
                            <button
                                type="button"
                                className="button button--ghost"
                                data-testid="phrase-seed-custom-open"
                                disabled={!canStart}
                                title={
                                    canStart
                                        ? 'Start this phrase on a Seed you write here, instead of the compiled Summary.'
                                        : refusal
                                }
                                onClick={() => setArmed(true)}
                            >
                                Start from your own brief
                            </button>
                        )}
                    </div>
                    {canStart || armed ? null : (
                        <p className="sv-group-notice sv-group-notice--warn" data-testid="phrase-seed-refusal">
                            {refusal}
                        </p>
                    )}

                    {armed ? (
                        // THE PASTE ARM. One field, one verb, the handoff's own note and refusal: the phrase's brief
                        // is where the structure gets argued, and this form only names the text to copy.
                        <div className="sv-reviewed-confirm" data-testid="phrase-seed-custom">
                            <p className="sv-group-notice" data-testid="phrase-seed-custom-note">
                                What you write here becomes the Seed instead of the compiled Summary. The Editor
                                structures it into chapters exactly as it does the Overview, and the start is still
                                one-way (D-72).
                            </p>
                            <textarea
                                className="sv-summary-field"
                                data-testid="phrase-seed-custom-text"
                                rows={5}
                                value={seed}
                                placeholder="the chapter plan you want this phrase built from — e.g. six chapters, alternating timeline, no frame story"
                                onChange={(event) => setSeed(event.target.value)}
                            />
                            <div className="sv-summary-actions">
                                <button
                                    type="button"
                                    data-testid="phrase-seed-custom-submit"
                                    disabled={!canStartCustom}
                                    title={canStartCustom ? 'Start this phrase on this text.' : seedRefusal}
                                    onClick={startCustom}
                                >
                                    {`Start ${phrase.title} from this Seed`}
                                </button>
                                <button
                                    type="button"
                                    data-testid="phrase-seed-custom-cancel"
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
                </>
            )}
        </section>
    );
}

export default PhraseSeedPane;
