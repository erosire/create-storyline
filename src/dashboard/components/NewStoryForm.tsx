// §10.2 U-12 + P5 + R1/R2/R4 (W2) — the New Story form: a title, a Seed, WHICH PHRASE the book opens on, an
// optional chapter count, and an optional Editor proofread of the brief before any of it is sent.
//
// WHY IT SITS ON THE HOME VIEW: U-12 requires the Dashboard to work with zero harnesses running, and the first
// thing that is true of a brand-new Story is that nothing runs on it yet. So the entry point to the whole product
// is the Author writing the one artifact every later crew is measured against (P5: the Seed is read-only for every
// agent, forever).
//
// R1 — THE PHRASE IS CHOSEN FROM THE SERVER'S CATALOG, NOT FROM A LABEL ON THIS BUTTON. The form used to offer one
// hardcoded act, "Write the Summary", which quietly meant "the only phrase a Story can open on is the one the loop
// mints" — and the same sentence was the desk's answer to an Author who wanted to start a book ON its chapter
// contracts. The options now come from `GET /phrases` (`api.ts:getPhraseCatalog`), in the catalog's own order, with
// the phrase's own `title` and `description`, and the press sends the selected key as `POST /stories`'
// `start_phrase` (the engine starts that phrase and opens the phase its catalog row names, in the create's own
// commit — no follow-up Start press, and no window where a sweep catches a book in phase ① that was created for
// somewhere else). A THIRD phrase kind therefore arrives as data: one more selector row, no new selector, and no
// new verb here (P15).
//
// WHY "NOTHING YET" IS AN OPTION AND NOT A PHASE NAME. The catalog lists EVERY enabled kind (W4), and the row says
// which kind it is: `starts_on_demand` is a press the Author makes, `starts_on_create` is the row the Server mints
// WITH the Story. Only the pressable ones are selectable here; an on-create kind is listed but disabled, because the
// start verb answers a press on it with a 409 that names the rule, and a picker that offered it would be offering a
// refusal. A create with no `start_phrase` is the ordinary one ("an omitted key is the normal create", `routes.ts`),
// and this arm is that create: the Author names no phrase, and the desk says what happens instead of naming one the
// wire cannot start.
//
// R2 — THE PROOFREAD SWITCH IS OFF, AND OFF MEANS NO MODEL TURN. The Editor's one-shot proofread
// (`POST /phrases/:key/seed/cleanup`, body `{ seed }`) is the same pass the in-story handoff card offers, addressed
// by PHRASE KIND because there is no Story yet. It writes nothing (P10) and the confirm is the create press, so the
// desk keeps it behind an explicit switch: an Author who did not ask for a proofread does not pay for one, and an
// Author who did gets a PROPOSAL they accept or reject with their own hands. NOTHING here replaces the text in the
// box by itself — that is AC3's rule, and the two buttons under a proposal are the only thing that moves it.
// W6 — THE SWITCH IS FOR EVERY STARTABLE PHRASE, INCLUDING THE KIND THE CREATE MINTS. The ask is addressed to the
// key the create will send, and when the Author named none that is the catalog's own on-create row (`askKey`):
// that phrase's Seed is the brief in this box, so the Editor has the same bytes to read here as it does for a
// pressed kind. The route takes that key (`api.ts:requestSeedCleanupDraft` — the workspace leg lists every key
// `GET /phrases` answers), and the earlier "no phrase named means nothing to proofread" clause was the client
// keeping a promise the server never made.
//
// R4 — THE CHAPTER COUNT IS HERE, AND BLANK IS NOT ZERO. The old header of this file said the count did not belong
// on the screen that opens a Story, because phase ① samples the Summary and the count binds phase ②. R2 (W2) moved
// the decision: `POST /stories` can now RECORD the declaration (`Story.chapter_count_request`), and a book created
// onto Phrase ② needs the number at the create or the Editor's brief answers a question the Author has not been
// asked yet. So the box is OPTIONAL and its emptiness is a real answer — "the Editor decides" — which is why the
// form sends `chapter_count` only when the Author typed a number (an empty box must not become `0`, `NaN`, or the
// actual default of 1). A value that is not a whole number ≥ 1 is refused here, before the route spends a commit
// saying the same thing.
import { useRef, useState } from 'react';
import { useDashboard, useDashboardStore } from '../state';
import {
    chapterCountInputRefusal,
    // R7's sentences, reused rather than rewritten: the create form's proofread and the handoff card's are the
    // SAME pass over the SAME kind of draft, so the two surfaces cannot describe one answer differently.
    SEED_CLEANUP_APPLIED_NOTE,
    SEED_CLEANUP_NOTHING_TO_FIX,
    SEED_CLEANUP_PROPOSAL_NOTE,
    seedCleanupAskRefusal,
    seedCleanupRefusalNotice
} from './story-contract';
import type { SeedCleanupProposal } from '../api';

export function NewStoryForm() {
    const store = useDashboardStore();
    // R1 — the phrase arm reads the STORE's copy of the catalog rather than fetching its own: the store is the
    // desk's only mirror of the server (P1), and `state.ts:refreshPhraseCatalog` keeps this list current with the
    // stream and with every "reload the desk".
    const { phraseCatalog, phraseCatalogError } = useDashboard();

    const [title, setTitle] = useState('');
    const [idea, setIdea] = useState('');
    // R1 — the selected phrase key. `''` is "the Author named nothing", which is the ordinary create, and it is
    // kept as a KEY rather than an index so a catalog that re-renders (or arrives late) cannot silently move the
    // Author's choice onto a different phrase.
    const [startPhrase, setStartPhrase] = useState('');
    // R4 — the chapter count as TYPED. The empty string is the third state of the wire field, so it is stored as
    // text and never coerced: `Number('')` is `0`, and `0` is a number the server refuses for a different reason.
    const [count, setCount] = useState('');
    // R2 — OFF by default, and off is not a collapsed UI, it is a decision not to spend a model turn.
    const [proofread, setProofread] = useState(false);
    const [proposal, setProposal] = useState<SeedCleanupProposal | null>(null);
    const [taken, setTaken] = useState(false);
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    // The box's CURRENT text, readable from the answer's continuation. `idea` inside the closure is the value at
    // press time, so comparing it with itself would prove nothing; the handoff card uses the same ref for the same
    // reason (`PlotlinesHandoff.tsx:draft`).
    const liveSeed = useRef(idea);

    liveSeed.current = idea;

    // The catalog as the desk has it: `null` is "the read has not landed (or failed)", which is NOT the same claim
    // as "this build offers no phrase to start on". The form renders its "name nothing" arm either way, and the
    // proofread ask stays shut until the list says which kind it may address.
    const catalog = phraseCatalog ?? [];
    // W4 SPLITS THE LIST, and the split is the row's own field: `starts_on_demand` is a press the Author makes,
    // `starts_on_create` is the row the Server mints WITH the Story. Only a press can be selected here; an
    // on-create kind is named below the select as the default, because offering it as a press is offering the 409
    // the start verb answers a non-demand kind with (R1).
    const pressable = catalog.filter((entry) => entry.starts_on_demand);
    const defaults = catalog.filter((entry) => !entry.starts_on_demand);
    // `starts_on_demand` is re-checked here, not trusted from the control: a catalog that reloads with the dial
    // switched off must not keep sending a key the server has stopped offering.
    const selected = pressable.find((entry) => entry.key === startPhrase);

    // The Seed and a title are the only hard requirements: phase ①'s crews expand the Seed
    // (D-4), so an empty Seed gives them nothing to measure against.
    const canCreate =
        title.trim().length > 0 && idea.trim().length > 0 && chapterCountInputRefusal(count) === '' && !busy;

    // R4 — the refusal the box carries, and the number the create will send. Blank sends NOTHING (the key is
    // omitted, and the row records `chapter_count_request: null`).
    const countRefusal = chapterCountInputRefusal(count);
    const chapterCount = count.trim() === '' ? undefined : Number(count.trim());

    // R2 — the ask's own gate. `seedCleanupAskRefusal` is the handoff card's rule (the shell must have the verb, and
    // the box must hold a draft the pass can read — the route 400s a blank `seed` rather than spend a call on an
    // answer it already knows); the catalog clause is this form's own, because the proofread is addressed BY PHRASE
    // KIND and a form with no kind to address it to has no ask.
    const cleanupRefusal = seedCleanupAskRefusal(idea, store.requestSeedCleanupDraft !== undefined);
    // W6 (R2) — WHICH PHRASE KIND THE ASK IS ADDRESSED TO, read off the catalog rather than named in this file. A
    // pressable pick names itself. With NO pick, the create opens the book on the kind its own row says it mints
    // (`starts_on_create`), and THAT phrase's Seed is the very brief in this box: Phrase ①'s `seed_source` is
    // `'story_idea'`, so the create writes `seed = stories.idea` (`storyline: phrase/catalog.ts:phraseSeedInitOf`)
    // — the same bytes a Plotlines brief would be proofread on. This used to be a REFUSAL ("there is nothing to
    // proofread separately — pick a phrase you press Start on"), and the workspace leg's W6 correction is what
    // retired it: `POST /phrases/{key}/seed/cleanup` takes EVERY key `GET /phrases` lists, Summary included, and
    // R2 offers the cleanup switch for every startable phrase, not only the pressable ones.
    // If a build ever lists more than one on-create kind, the FIRST in the server's catalog order is the answer —
    // the order is the catalog's, so the desk never re-derives the default from a preference (R1).
    const askKey = selected?.key ?? defaults[0]?.key;
    // THE ONLY CATALOG FACT LEFT THAT CAN SHUT THE ASK: this build names no kind a book can open on at all — either
    // the read has not landed, or every definition is switched off. U-16 keeps those two facts in different
    // sentences, because "the read has not answered" and "there is nothing to start on" are different things for an
    // Author to act on (wait, or switch a dial on), and a merged sentence is a shrug (L-13).
    const draftOnlyRefusal =
        store.requestSeedCleanupDraft === undefined || cleanupRefusal !== '' || askKey !== undefined
            ? ''
            : phraseCatalog === null
              ? 'The phrase catalog has not answered, so this form has no phrase kind to address the proofread to — the ask opens when the catalog lands (R1, R7).'
              : 'The proofread is the Editor’s pass over your brief FOR THE PHRASE you start on, and this build’s catalog lists no kind a book can open on, so there is no phrase to address the ask to (R1, R7).';
    const askRefusal = proofread ? (cleanupRefusal === '' ? draftOnlyRefusal : cleanupRefusal) : draftOnlyRefusal;
    const canAskProofread = proofread && askRefusal === '' && !asking;

    /**
     * R2 — one proofread of the draft, against the phrase kind the create will name.
     *
     * THE STALE-ANSWER GUARD IS THE PART THAT HAS TO BE HERE. This is the slowest thing the form can start, and the
     * Author keeps typing while it runs. The proposal is about the bytes that were in the box when the ask was
     * pressed — `source_hash` hashes the trimmed draft the pass read — so an answer whose draft has moved on is
     * DROPPED rather than shown: "Use this text" over a brief the Editor never read would be a way to replace text
     * with a suggestion computed on something else.
     */
    const askProofread = async () => {
        if (!canAskProofread || askKey === undefined || store.requestSeedCleanupDraft === undefined) {
            return;
        }

        const asked = idea;

        setAsking(true);
        // THE PREVIOUS ANSWER DIES WITH THE REQUEST, so two proposals never sit on screen claiming one draft.
        setProposal(null);
        setTaken(false);

        // W6 — the key is the one the CREATE will name, or the on-create kind it mints when the Author named
        // nothing: the route proofreads the bytes that kind's Seed will be, so an ask addressed to any other key
        // would be a pass over a brief that phrase never holds (R2).
        const answer = await store.requestSeedCleanupDraft(askKey, asked);

        setAsking(false);

        // `null` is the route's 400 / 404 / 409, whose sentence the store has already committed to the shell's error
        // line (L-13). The form shows nothing rather than a second copy of the same sentence, and shows no proposal,
        // because there is none.
        // THE STALE-ANSWER GUARD: the box moved while the Editor was reading, so this answer belongs to bytes the
        // Author is no longer looking at, and `source_hash` cannot bind it to the new text. Dropped, not applied —
        // the ask button is right there to press again on the text that is actually in the box.
        if (answer === null || liveSeed.current !== asked) {
            return;
        }

        setProposal(answer);
    };

    /**
     * "Use this text" — the ONLY thing a proposal may do, and it is not a write. Nothing reaches the Story until
     * the create press copies the box (P5 / D-72), so accepting changes the draft and marks it TAKEN; the Author's
     * own press is still what records anything (AC3).
     */
    const takeProposal = () => {
        if (proposal === null || !proposal.ok || !proposal.changed) return;

        setIdea(proposal.text);
        setTaken(true);
    };

    /** "Keep mine" — the rejection, which is also a state worth naming: the draft stands and nothing was changed. */
    const rejectProposal = () => {
        setProposal(null);
        setTaken(false);
    };

    /** Every keystroke retires the proposal: `source_hash` binds it to the draft the pass actually read. */
    const onSeedChange = (value: string): void => {
        setIdea(value);

        if (proposal !== null) {
            setProposal(null);
            setTaken(false);
        }
    };

    const submit = async () => {
        if (!canCreate) {
            return;
        }

        setBusy(true);
        // R1 / R4 — the body carries ONLY what the Author decided. No key when no phrase was named (the engine's own
        // default create), and no `chapter_count` when the box is empty ("the Editor decides"). The proofread
        // proposal needs no key at all: taking one put its text in the box, and the box is what the create copies.
        const row = await store.createStory({
            title: title.trim(),
            idea: idea.trim(),
            ...(selected === undefined ? {} : { start_phrase: selected.key }),
            ...(chapterCount === undefined ? {} : { chapter_count: chapterCount })
        });
        setBusy(false);
        // Only cleared when the write landed — a refused create keeps the Author's draft.
        if (row) {
            setTitle('');
            setIdea('');
            setCount('');
            setProposal(null);
            setTaken(false);
        }
    };

    return (
        <form
            className="new-story"
            data-testid="new-story-form"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <h2 className="panel__title">Start a Story</h2>
            <p className="panel__hint">the Seed is yours and read-only for every crew, forever (P5).</p>

            <label className="field">
                <span className="field__label">Title</span>
                <input
                    className="field__input"
                    name="title"
                    data-testid="field-title"
                    value={title}
                    autoComplete="off"
                    placeholder="the mentor's second death"
                    onChange={(event) => setTitle(event.target.value)}
                />
            </label>

            <label className="field">
                <span className="field__label">Seed</span>
                <textarea
                    className="field__input field__input--seed"
                    name="idea"
                    data-testid="field-seed"
                    rows={5}
                    value={idea}
                    placeholder="a disgraced cartographer must map the sea that ate her fleet, and the sea remembers her name"
                    onChange={(event) => onSeedChange(event.target.value)}
                />
            </label>

            {/* R1 — THE PHRASE THE BOOK OPENS ON, one row per catalog kind, in the catalog's order, in the catalog's
                words. Nothing here names a phrase: the option list, the option's label and the sentence under it are
                all read off the row, so a phrase the server turns on appears without a client change (P15).
                `field-phrase-none` is the create that names no phrase — the ordinary one. An on-create kind is LISTED
                (the Author can see the catalog knows it) and DISABLED (the start verb refuses a press on it, R1). */}
            <div className="field" data-testid="field-phrase-block">
                <span className="field__label">Start this Story on</span>
                <select
                    className="field__input"
                    name="start_phrase"
                    data-testid="field-phrase"
                    value={startPhrase}
                    onChange={(event) => {
                        setStartPhrase(event.target.value);
                        // A different phrase is a different question for the Editor to proofread, so the old answer
                        // is retired with the phrase that earned it.
                        setProposal(null);
                        setTaken(false);
                    }}
                >
                    <option value="" data-testid="field-phrase-none">
                        Nothing yet — the create opens the Story on the phrase it mints from your Seed
                    </option>
                    {catalog.map((entry) => (
                        <option
                            key={entry.key}
                            // A disabled option still carries its key as its value, so a test (and the browser's own
                            // option list) can see WHICH kind the catalog offers, and that this desk cannot press it.
                            value={entry.key}
                            disabled={!entry.starts_on_demand}
                            data-testid={`field-phrase-${entry.key}`}
                            title={
                                entry.starts_on_demand
                                    ? entry.description
                                    : 'This phrase arrives WITH the Story: the create mints its row from your Seed, so there is nothing here to press (R1).'
                            }
                        >
                            {entry.starts_on_demand
                                ? entry.title
                                : `${entry.title} — arrives with the Story, nothing to press`}
                        </option>
                    ))}
                </select>
                {/* The phrase's own description, which is the decision's actual content: what starting it MEANS.
                    Printing the catalog's sentence rather than a paraphrase is what keeps this form and the
                    engine's `enters_phase` from telling two stories about one phrase. With no phrase named, the line
                    names whatever the catalog says the create mints — read off `starts_on_create`, never off a
                    hardcoded 'Summary'. */}
                {selected === undefined ? (
                    <span className="field__hint" data-testid="field-phrase-note">
                        {phraseCatalog === null
                            ? 'The phrase catalog has not answered, so this form offers only the create that names no phrase (R1).'
                            : defaults.length === 0
                              ? 'You are naming no phrase: the create mints the Story’s first phrase from your Seed, and the loop starts there (R1).'
                              : `You are naming no phrase, and ${defaults.map((entry) => `“${entry.title}”`).join(', ')} is the phrase the create mints from your Seed — its row arrives WITH the Story, and the loop starts there (R1).`}
                    </span>
                ) : (
                    <span className="field__hint" data-testid="field-phrase-note">
                        {selected.description}
                    </span>
                )}
                {phraseCatalog === null && phraseCatalogError !== null ? (
                    // L-13 — the server's own sentence, because "no phrases" and "the read failed" are different
                    // facts and the Author is about to act on which one it is.
                    <span className="field__hint" data-testid="field-phrase-error" title={phraseCatalogError}>
                        {'The phrase catalog could not be read, so a phrase you might start on is not offered here.'}
                    </span>
                ) : null}
            </div>

            {/* R4 — the count is OPTIONAL, and the honest wording is the whole design: an empty box is "the Editor
                decides", not a zero and not the actual default of 1. */}
            <label className="field" data-testid="field-chapter-count-block">
                <span className="field__label">Chapter count (optional)</span>
                <input
                    className="field__input"
                    name="chapter_count"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="leave empty to let the Editor decide"
                    data-testid="field-chapter-count"
                    value={count}
                    onChange={(event) => setCount(event.target.value)}
                />
                {countRefusal === '' ? (
                    <span className="field__hint" data-testid="field-chapter-count-note">
                        {count.trim() === ''
                            ? 'Blank is an answer: the Editor proposes the count and you accept it with the brief (D-3b). It is not 0, and it is not 1.'
                            : `You are declaring ${count.trim()} ${Number(count.trim()) === 1 ? 'chapter' : 'chapters'} — a declared count is Author truth, and the honor-the-request check reads it (D-3b).`}
                    </span>
                ) : (
                    <span className="field__hint field__hint--warn" data-testid="field-chapter-count-refusal">
                        {countRefusal}
                    </span>
                )}
            </label>

            {/* R2 — THE PROOFREAD SWITCH. Off means the ask is never dialled and no model turn is spent; on means
                the ask is offered and STILL changes nothing by itself. The switch is not a collapsed form: the
                sentence says which of the two the Author is looking at (U-16). */}
            <label className="field field--switch" data-testid="field-cleanup-block">
                <span className="field__label">Editor proofread before the create</span>
                <span className="field__row">
                    <input
                        type="checkbox"
                        name="seed_cleanup"
                        data-testid="field-cleanup"
                        checked={proofread}
                        onChange={(event) => {
                            setProofread(event.target.checked);
                            // Turning the switch OFF retires the answer it produced: a proposal under a closed
                            // switch would be a suggestion the Author can still take without having asked.
                            setProposal(null);
                            setTaken(false);
                        }}
                    />
                    <span className="field__hint" data-testid="field-cleanup-note">
                        {proofread
                            ? 'On: one look at the grammar, spelling and punctuation of the brief above, before anything is created. Nothing is written, and the Seed the create copies is still the text in the box (R7).'
                            : 'Off: the brief goes to the create exactly as you wrote it, and no model is asked (R7).'}
                    </span>
                </span>
            </label>

            {proofread ? (
                <div className="new-story__cleanup" data-testid="field-cleanup-panel">
                    <div className="field__row">
                        <button
                            type="button"
                            className="button button--ghost"
                            data-testid="field-cleanup-ask"
                            disabled={!canAskProofread}
                            // U-16: a shut control says WHICH fact shuts it — no draft, no verb, no catalog kind to
                            // address the ask to (W6: only when the read has not landed or the build lists no
                            // startable kind), or the pass that is already reading this one.
                            title={asking ? 'The Editor is reading your brief.' : canAskProofread ? askRefusal || 'Ask for the one-time proofread (R7).' : askRefusal}
                            onClick={() => void askProofread()}
                        >
                            {asking ? 'The Editor is reading…' : 'Ask the Editor to proofread this'}
                        </button>
                    </div>

                    {proposal === null ? null : !proposal.ok ? (
                        /* THE GUARD REFUSED, AND IT IS AN ANSWER (AC3). No `text`, so there is nothing to take; the
                           sentence names which rule fired, and the draft in the box is still the Author's. Not an
                           error strip: the request succeeded. */
                        <p className="panel__hint" data-testid="field-cleanup-refusal">
                            {/* W4/R6 — the optional `blocker` is the server saying ITS prompt file is refused, and it
                                owns the sentence; the `refusal` code alone would blame the Author's draft. */}
                            {seedCleanupRefusalNotice(proposal.refusal, proposal.blocker)}
                        </p>
                    ) : !proposal.changed ? (
                        <p className="panel__hint" data-testid="field-cleanup-clean">
                            {SEED_CLEANUP_NOTHING_TO_FIX}
                        </p>
                    ) : taken ? (
                        /* TAKEN, NOT CREATED. The box changed, so the form says plainly that nothing was written and
                           which press does the writing — the reading an Author is most likely to get wrong after
                           watching a box change on its own. */
                        <p className="panel__hint" data-testid="field-cleanup-taken">
                            {SEED_CLEANUP_APPLIED_NOTE}
                        </p>
                    ) : (
                        <>
                            <p className="panel__hint" data-testid="field-cleanup-proposal-note">
                                {SEED_CLEANUP_PROPOSAL_NOTE}
                            </p>
                            {/* PLAIN TEXT, not Markdown: this is a CANDIDATE, and styling it like a document would
                                read a suggestion as a record (the handoff card's same call, one surface over). */}
                            <p className="field__input field__input--seed" data-testid="field-cleanup-proposal">
                                {proposal.text}
                            </p>
                            <div className="field__row">
                                <button
                                    type="button"
                                    data-testid="field-cleanup-accept"
                                    // The button moves text into the box; only the create press records anything.
                                    title="Puts the Editor’s text in the Seed box above. Nothing is created or copied until you press the button below (R7 / D-72)."
                                    onClick={takeProposal}
                                >
                                    Use this text
                                </button>
                                <button
                                    type="button"
                                    className="button button--ghost"
                                    data-testid="field-cleanup-reject"
                                    title="Keeps the brief you wrote. The Editor’s text is dropped and nothing is written (R7)."
                                    onClick={rejectProposal}
                                >
                                    Keep my text
                                </button>
                            </div>
                        </>
                    )}
                </div>
            ) : null}

            <button
                type="submit"
                className="button button--primary"
                data-testid="field-create"
                disabled={!canCreate}
                // U-16 — the reason a shut create is shut, in the order the Author meets it.
                title={
                    busy
                        ? 'The create is on its way.'
                        : canCreate
                          ? 'Writes the Seed and starts the Story. The phrase you named above is started in the same commit (R1).'
                          : 'A Story needs a title and a Seed; the chapter count is optional, and whatever is in it has to be a whole number of chapters.'
                }
            >
                {/* R1 — the label is built from the selected row, so the button names the act the catalog offers
                    instead of one hardcoded phrase's verb. With no phrase named it says the ordinary thing a create
                    does. */}
                {selected === undefined ? 'Create the Story' : `Start the ${selected.title}`}
            </button>
        </form>
    );
}

export default NewStoryForm;
