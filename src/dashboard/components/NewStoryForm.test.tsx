// R1 / R2 / R4 — the create form is the desk's first act, and three of this wave's requirements live here.
//
//   · R1 — the phrase the book opens on comes off `GET /phrases` (`api.ts:getPhraseCatalog`), in the catalog's order,
//     in the catalog's words. Nothing in this file names a phrase: the option list, the option's label, the sentence
//     under the select and the create button's own verb are all read off the row, so a kind the server turns on
//     appears with no client change (P15). A kind the create mints is LISTED and DISABLED — the start verb refuses a
//     press on it — and that is a fact the Author reads, not a missing option.
//   · R2 — the Editor's proofread is a SWITCH, off by default, and off spends no model call. On, it asks about the
//     draft in the box, gets a PROPOSAL, and changes nothing by itself: "Use this text" moves text into a box, and
//     only the create press records anything (AC3). A guard refusal is an answer with its own sentence, not an error.
//   · R4 — the chapter count is optional and its three states travel differently: blank omits the key, a whole
//     number ≥ 1 sends the declaration, and anything else is refused before the route is dialed.
//
// Copy is asserted as the literals the component prints, and the refusal sentences come from the contract module's
// own helpers — the same call the form makes — so a copy edit lands in one place and this suite says so.
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { NewStoryForm } from './NewStoryForm';
import { click, renderShell, type } from '../testing/shell-fakes';
import { PHRASE_CATALOG_ROWS } from '../testing/product-values';
import {
    chapterCountInputRefusal,
    seedCleanupAskRefusal,
    seedCleanupRefusalNotice,
    SEED_CLEANUP_APPLIED_NOTE,
    SEED_CLEANUP_NOTHING_TO_FIX,
    SEED_CLEANUP_PROPOSAL_NOTE
} from './story-contract';
import { ApiError } from '../api';
import type { ApiClient, SeedCleanupProposal } from '../api';

const SUMMARY_ROW = PHRASE_CATALOG_ROWS.find((row) => row.key === 'summary')!;
const PLOTLINES_ROW = PHRASE_CATALOG_ROWS.find((row) => row.key === 'plotlines')!;

/** The catalog rows this build answers with, in the server's own order (`testing/product-values.ts`). */
const ON_CREATE = PHRASE_CATALOG_ROWS.filter((row) => !row.starts_on_demand);
const PRESSABLE = PHRASE_CATALOG_ROWS.filter((row) => row.starts_on_demand);

/** The create body the client actually received, as the literal object it sent. */
function createCalls(client: ApiClient): Array<Record<string, unknown>> {
    return (client.createStory as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls.map(
        ([input]) => input
    );
}

/** The cleanup verb's calls, per argument list, so a test can pin WHICH phrase kind the ask was addressed to. */
function draftCleanupCalls(client: ApiClient): unknown[][] {
    return (client.requestSeedCleanupDraft as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

/** Types the two facts a create cannot do without, leaving the optional boxes as they stand. */
async function writeTitleAndSeed() {
    await type(screen.getByTestId('field-title'), 'The Second Death');
    await type(screen.getByTestId('field-seed'), 'a cartographer maps the sea that ate her fleet');
}

describe('NewStoryForm — the entry point (U-12)', () => {
    it('keeps the create disabled until the Seed exists (P5)', async () => {
        await renderShell(<NewStoryForm />);

        const create = screen.getByTestId('field-create') as HTMLButtonElement;

        expect(create.disabled).toBe(true);

        await type(screen.getByTestId('field-title'), 'The Second Death');

        expect(create.disabled).toBe(true);
        expect(create.getAttribute('title')).toBe(
            'A Story needs a title and a Seed; the chapter count is optional, and whatever is in it has to be a whole number of chapters.'
        );

        await writeTitleAndSeed();

        expect(create.disabled).toBe(false);
        expect(create.getAttribute('title')).toBe(
            'Writes the Seed and starts the Story. The phrase you named above is started in the same commit (R1).'
        );
    });

    it('creates the Story from the Seed, and the optional box is empty rather than pre-filled with a guess (R4)', async () => {
        const { client, store } = await renderShell(<NewStoryForm />);

        // THE BOX IS THERE, and it is EMPTY: a placeholder number would be an author request the Author never made,
        // and the desk has to be able to tell a declaration from "the Editor decides" (R4).
        const count = screen.getByTestId('field-chapter-count') as HTMLInputElement;

        expect(count.value).toBe('');
        expect(count.getAttribute('placeholder')).toBe('leave empty to let the Editor decide');
        expect(screen.getByTestId('field-chapter-count-note').textContent).toBe(
            'Blank is an answer: the Editor proposes the count and you accept it with the brief (D-3b). It is not 0, and it is not 1.'
        );

        await writeTitleAndSeed();
        await click(screen.getByTestId('field-create'));

        // ONE key set: the two required facts, and NEITHER optional key.
        expect(createCalls(client)).toEqual([
            { title: 'The Second Death', idea: 'a cartographer maps the sea that ate her fleet' }
        ]);
        // The new Story becomes THE STORY at once: the Author just wrote a Seed, and the next thing they do is work
        // phase ① against it.
        expect(store.getSnapshot().activeStoryId).toBe('story_new');
        expect((screen.getByTestId('field-seed') as HTMLTextAreaElement).value).toBe('');
    });
});

describe('NewStoryForm — the phrase comes from the catalog, not from this file (R1)', () => {
    it('offers every kind the catalog lists, in the catalog’s order, and labels each one from its own row', async () => {
        await renderShell(<NewStoryForm />);

        const select = screen.getByTestId('field-phrase') as HTMLSelectElement;
        const options = Array.from(select.querySelectorAll('option'));

        // The no-phrase create first, then EVERY enabled row in the read's order — including the kind the create
        // mints, which is on the list precisely so the Author can see the catalog knows it.
        expect(options.map((option) => [option.getAttribute('data-testid'), option.textContent])).toEqual([
            ['field-phrase-none', 'Nothing yet — the create opens the Story on the phrase it mints from your Seed'],
            ...PHRASE_CATALOG_ROWS.map((row) => [
                `field-phrase-${row.key}`,
                row.starts_on_demand
                    ? row.title
                    : `${row.title} — arrives with the Story, nothing to press`
            ])
        ]);
        // A kind the create mints is DISABLED: the start verb refuses a press on it, and an option that looked
        // pressable would promise a start the route answers with a 409 (R1).
        expect(options.map((option) => option.disabled)).toEqual([
            false,
            ...PHRASE_CATALOG_ROWS.map((row) => !row.starts_on_demand)
        ]);
        expect((screen.getByTestId('field-phrase-summary') as HTMLOptionElement).getAttribute('title')).toBe(
            'This phrase arrives WITH the Story: the create mints its row from your Seed, so there is nothing here to press (R1).'
        );
        expect((screen.getByTestId('field-phrase-plotlines') as HTMLOptionElement).getAttribute('title')).toBe(
            PLOTLINES_ROW.description
        );
    });

    it('names the phrase the create mints from the catalog rather than a hard-coded Summary', async () => {
        await renderShell(<NewStoryForm />);

        // With no phrase named, the hint says which kind the create will mint — a sentence built from the rows, so
        // a server that turned a different kind into the on-create one would be described correctly here too.
        expect(screen.getByTestId('field-phrase-note').textContent).toBe(
            `You are naming no phrase, and ${ON_CREATE.map((row) => `“${row.title}”`).join(', ')} is the phrase the create mints from your Seed — its row arrives WITH the Story, and the loop starts there (R1).`
        );
        expect(screen.getByTestId('field-create').textContent).toBe('Create the Story');
    });

    it('shows the selected row’s own description, and puts the row’s verb on the create button', async () => {
        await renderShell(<NewStoryForm />);

        await type(screen.getByTestId('field-phrase'), PLOTLINES_ROW.key);

        expect(screen.getByTestId('field-phrase-note').textContent).toBe(PLOTLINES_ROW.description);
        expect(screen.getByTestId('field-create').textContent).toBe(`Start the ${PLOTLINES_ROW.title}`);
    });

    it('sends start_phrase for the phrase pressed, and omits the key when none is named', async () => {
        const { client } = await renderShell(<NewStoryForm />);

        await writeTitleAndSeed();
        await type(screen.getByTestId('field-phrase'), PLOTLINES_ROW.key);
        await click(screen.getByTestId('field-create'));

        expect(createCalls(client)).toEqual([
            {
                title: 'The Second Death',
                idea: 'a cartographer maps the sea that ate her fleet',
                start_phrase: 'plotlines'
            }
        ]);
    });

    it('offers only the no-phrase create when the catalog has not answered, and says which of the two it is', async () => {
        // A FAILED read is not an empty catalog: `phraseCatalog: null` with the server's sentence beside it, and the
        // form must not offer a phrase it has not been told about (L-13).
        const { client } = await renderShell(<NewStoryForm />, [], [], {
            getPhraseCatalog: vi.fn(async (): Promise<never> => {
                throw new ApiError(503, 'the phrase catalog is unread right now');
            })
        });

        const options = Array.from((screen.getByTestId('field-phrase') as HTMLSelectElement).querySelectorAll('option'));

        expect(options.map((option) => option.getAttribute('data-testid'))).toEqual(['field-phrase-none']);
        expect(screen.getByTestId('field-phrase-note').textContent).toBe(
            'The phrase catalog has not answered, so this form offers only the create that names no phrase (R1).'
        );
        expect(screen.getByTestId('field-phrase-error').textContent).toBe(
            'The phrase catalog could not be read, so a phrase you might start on is not offered here.'
        );
        // The server's sentence rides the `title`, verbatim.
        expect(screen.getByTestId('field-phrase-error').getAttribute('title')).toBe('the phrase catalog is unread right now');
        // And a create with no phrase is still a create: nothing about the failure shuts the ordinary act.
        await writeTitleAndSeed();
        await click(screen.getByTestId('field-create'));

        // The failure costs the Author the OPTIONS, not the ordinary create: the body carries no `start_phrase`.
        expect(createCalls(client)).toEqual([
            { title: 'The Second Death', idea: 'a cartographer maps the sea that ate her fleet' }
        ]);
    });
});

describe('NewStoryForm — the chapter count has three answers, and one refusal (R4)', () => {
    it('sends the declared count as a number, beside the phrase the Author pressed', async () => {
        const { client } = await renderShell(<NewStoryForm />);

        await writeTitleAndSeed();
        await type(screen.getByTestId('field-chapter-count'), '6');
        expect(screen.getByTestId('field-chapter-count-note').textContent).toBe(
            'You are declaring 6 chapters — a declared count is Author truth, and the honor-the-request check reads it (D-3b).'
        );
        await click(screen.getByTestId('field-create'));

        expect(createCalls(client)).toEqual([
            { title: 'The Second Death', idea: 'a cartographer maps the sea that ate her fleet', chapter_count: 6 }
        ]);
    });

    it('says a declared ONE in the singular, because a count the Editor reads is a sentence about a book', async () => {
        await renderShell(<NewStoryForm />);

        await type(screen.getByTestId('field-chapter-count'), '1');

        expect(screen.getByTestId('field-chapter-count-note').textContent).toBe(
            'You are declaring 1 chapter — a declared count is Author truth, and the honor-the-request check reads it (D-3b).'
        );
    });

    it('refuses every count that is not a whole number of chapters, and keeps the create shut', async () => {
        await renderShell(<NewStoryForm />);

        await writeTitleAndSeed();

        for (const [typed, sentence] of [
            ['0', 'A chapter count of 0 asks for a book with no chapters. Leave the box empty to let the Editor decide (D-3b), or name a number from 1 up.'],
            ['1.5', 'A chapter count is a whole number of chapters — a count the Editor has to honor cannot be a fraction or a word (D-3b).'],
            ['seven', 'A chapter count is a whole number of chapters — a count the Editor has to honor cannot be a fraction or a word (D-3b).'],
            ['-3', 'A chapter count of 0 asks for a book with no chapters. Leave the box empty to let the Editor decide (D-3b), or name a number from 1 up.']
        ] as const) {
            await type(screen.getByTestId('field-chapter-count'), typed);

            expect(screen.getByTestId('field-chapter-count-refusal').textContent).toBe(sentence);
            expect((screen.getByTestId('field-create') as HTMLButtonElement).disabled).toBe(true);
            // The sentence is the contract helper's, so the box and the route cannot describe the same number
            // differently.
            expect(sentence).toBe(chapterCountInputRefusal(typed));
        }
    });

    it('sends NOTHING for a count the Author cleared, rather than a 0', async () => {
        const { client } = await renderShell(<NewStoryForm />);

        await writeTitleAndSeed();
        await type(screen.getByTestId('field-chapter-count'), '6');
        await type(screen.getByTestId('field-chapter-count'), '');
        await click(screen.getByTestId('field-create'));

        expect(createCalls(client)).toEqual([
            { title: 'The Second Death', idea: 'a cartographer maps the sea that ate her fleet' }
        ]);
    });
});

describe('NewStoryForm — the proofread is a switch, and its answer is a proposal (R2)', () => {
    it('spends no model call while the switch is off, and says that is what off means', async () => {
        const { client } = await renderShell(<NewStoryForm />);

        await writeTitleAndSeed();
        await click(screen.getByTestId('field-create'));

        expect((client.requestSeedCleanupDraft as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
        expect(screen.getByTestId('field-cleanup-note').textContent).toBe(
            'Off: the brief goes to the create exactly as you wrote it, and no model is asked (R7).'
        );
        expect(screen.queryByTestId('field-cleanup-panel')).toBeNull();
    });

    it('opens the ask for the phrase the create MINTS, and addresses it to that kind (W6, R2)', async () => {
        const { client } = await renderShell(<NewStoryForm />);

        await writeTitleAndSeed();
        await click(screen.getByTestId('field-cleanup'));

        expect(screen.getByTestId('field-cleanup-note').textContent).toBe(
            'On: one look at the grammar, spelling and punctuation of the brief above, before anything is created. Nothing is written, and the Seed the create copies is still the text in the box (R7).'
        );

        const ask = screen.getByTestId('field-cleanup-ask') as HTMLButtonElement;

        // W6 — THE SWITCH IS FOR EVERY STARTABLE PHRASE, and the default create is one of them. This used to be a
        // shut control with a sentence claiming the on-create kind had "nothing to proofread separately"; that was
        // false then and is falsified on the wire now — `POST /phrases/{key}/seed/cleanup` takes every key
        // `GET /phrases` lists, and Phrase ①'s Seed is the brief in this box (`seed_source: 'story_idea'`).
        expect(ask.disabled).toBe(false);
        expect(ask.getAttribute('title')).toBe('Ask for the one-time proofread (R7).');

        await click(ask);

        // ADDRESSED BY CATALOG DATA, NOT BY A NAME IN THIS FILE: with nothing pressed, the key is the row the read
        // marks `starts_on_create`, in the server's own order (R1).
        expect(draftCleanupCalls(client)).toEqual([
            [ON_CREATE[0].key, 'a cartographer maps the sea that ate her fleet']
        ]);
        expect(ON_CREATE[0].key).toBe(SUMMARY_ROW.key);
    });

    it('sends the accepted bytes on a create that names no phrase, with no extra key (W6, R2)', async () => {
        // THE CONFIRM IS THE CREATE. The proposal goes in the box and the next press carries the box — so the
        // Summary book opens on the PROOFREAD text, which is the whole point of offering the switch on the default
        // kind. Pinned as the literal body: no `start_phrase` (naming nothing is the ordinary create), and the
        // accepted bytes in `idea`.
        const proposal: SeedCleanupProposal = {
            ok: true,
            source_hash: '9b8387ee',
            text: 'A cartographer maps the sea that ate her fleet, and the sea remembers her name.',
            changed: true
        };
        const { client } = await renderShell(<NewStoryForm />, [], [], {
            requestSeedCleanupDraft: vi.fn(async (): Promise<SeedCleanupProposal> => proposal)
        });

        await writeTitleAndSeed();
        await click(screen.getByTestId('field-cleanup'));
        await click(screen.getByTestId('field-cleanup-ask'));

        expect(draftCleanupCalls(client)).toEqual([['summary', 'a cartographer maps the sea that ate her fleet']]);

        await click(screen.getByTestId('field-cleanup-accept'));

        expect((screen.getByTestId('field-seed') as HTMLTextAreaElement).value).toBe(proposal.text);

        await click(screen.getByTestId('field-create'));

        expect(createCalls(client)).toEqual([{ title: 'The Second Death', idea: proposal.text }]);
    });

    it('names the server’s own blocker when the refusal was not the Author’s (R6, W4)', async () => {
        // THE RIDE-ALONG THAT CHANGES THE SENTENCE. The route answers `refusal: 'empty_answer'` PLUS a `blocker`
        // when `seed-cleanup.md` is refused, and the guard's own line ("the Editor answered with nothing usable")
        // would tell the Author their brief was unreadable when the file that cannot be read is the server's.
        const blocker = 'seed-cleanup.md: `name: seed-cleaner` disagrees with `slug: seed-cleanup`';

        await renderShell(<NewStoryForm />, [], [], {
            requestSeedCleanupDraft: vi.fn(async (): Promise<SeedCleanupProposal> => ({
                ok: false,
                source_hash: '9b8387ee',
                refusal: 'empty_answer',
                blocker
            }))
        });

        await writeTitleAndSeed();
        await click(screen.getByTestId('field-cleanup'));
        await click(screen.getByTestId('field-cleanup-ask'));

        const refusal = screen.getByTestId('field-cleanup-refusal');

        expect(refusal.textContent).toBe(seedCleanupRefusalNotice('empty_answer', blocker));
        expect(refusal.textContent).toContain(blocker);
        // NOT the guard's line, which is the sentence the same code prints when the server had no blocker (R6).
        expect(refusal.textContent).not.toBe(seedCleanupRefusalNotice('empty_answer'));
        // The draft still stands, and nothing was written: a blocker is a 200 answer, not an error.
        expect((screen.getByTestId('field-seed') as HTMLTextAreaElement).value).toBe(
            'a cartographer maps the sea that ate her fleet'
        );
    });

    it('shuts the ask with an empty brief, on the helper’s own sentence', async () => {
        await renderShell(<NewStoryForm />);

        await type(screen.getByTestId('field-title'), 'The Second Death');
        await type(screen.getByTestId('field-phrase'), PLOTLINES_ROW.key);
        await click(screen.getByTestId('field-cleanup'));

        const ask = screen.getByTestId('field-cleanup-ask') as HTMLButtonElement;

        expect(ask.disabled).toBe(true);
        expect(ask.getAttribute('title')).toBe(seedCleanupAskRefusal('', true));
    });

    it('asks about the draft in the box, addressed by the kind the create will name', async () => {
        const { client } = await renderShell(<NewStoryForm />);

        await writeTitleAndSeed();
        await type(screen.getByTestId('field-phrase'), PLOTLINES_ROW.key);
        await click(screen.getByTestId('field-cleanup'));
        await click(screen.getByTestId('field-cleanup-ask'));

        expect(draftCleanupCalls(client)).toEqual([['plotlines', 'a cartographer maps the sea that ate her fleet']]);
        // The fake's answer is `changed: false` — the honest "nothing to fix" — which is an ANSWER and not a
        // failure, so the form prints the sentence and offers no accept.
        expect(screen.getByTestId('field-cleanup-clean').textContent).toBe(SEED_CLEANUP_NOTHING_TO_FIX);
        expect(screen.queryByTestId('field-cleanup-accept')).toBeNull();
    });

    it('shows a proposal as a candidate, and takes it into the box without recording anything', async () => {
        const proposal: SeedCleanupProposal = {
            ok: true,
            source_hash: '9b8387ee',
            text: 'A cartographer maps the sea that ate her fleet, and the sea remembers her name.',
            changed: true
        };
        const { client } = await renderShell(<NewStoryForm />, [], [], {
            requestSeedCleanupDraft: vi.fn(async (): Promise<SeedCleanupProposal> => proposal)
        });

        await writeTitleAndSeed();
        await type(screen.getByTestId('field-phrase'), PLOTLINES_ROW.key);
        await click(screen.getByTestId('field-cleanup'));
        await click(screen.getByTestId('field-cleanup-ask'));

        expect(screen.getByTestId('field-cleanup-proposal').textContent).toBe(proposal.text);
        expect(screen.getByTestId('field-cleanup-proposal-note').textContent).toBe(SEED_CLEANUP_PROPOSAL_NOTE);
        expect(screen.getByTestId('field-cleanup-accept').getAttribute('title')).toBe(
            'Puts the Editor’s text in the Seed box above. Nothing is created or copied until you press the button below (R7 / D-72).'
        );

        await click(screen.getByTestId('field-cleanup-accept'));

        // THE BOX CHANGED, AND NOTHING WAS WRITTEN — the reading an Author is most likely to get wrong, so the form
        // says it in the same breath as the changed box (AC3).
        expect((screen.getByTestId('field-seed') as HTMLTextAreaElement).value).toBe(proposal.text);
        expect(screen.getByTestId('field-cleanup-taken').textContent).toBe(SEED_CLEANUP_APPLIED_NOTE);
        expect(createCalls(client)).toEqual([]);

        // AND THE CREATE COPIES THE BOX: the accepted text is what travels, with no extra key for the proposal.
        await click(screen.getByTestId('field-create'));

        expect(createCalls(client)).toEqual([
            { title: 'The Second Death', idea: proposal.text, start_phrase: 'plotlines' }
        ]);
    });

    it('keeps the Author’s own text when the proposal is refused, and retires it on the next keystroke', async () => {
        const proposal: SeedCleanupProposal = {
            ok: true,
            source_hash: '9b8387ee',
            text: 'A cartographer maps the sea that ate her fleet, and the sea remembers her name.',
            changed: true
        };
        await renderShell(<NewStoryForm />, [], [], {
            requestSeedCleanupDraft: vi.fn(async (): Promise<SeedCleanupProposal> => proposal)
        });

        await writeTitleAndSeed();
        await type(screen.getByTestId('field-phrase'), PLOTLINES_ROW.key);
        await click(screen.getByTestId('field-cleanup'));
        await click(screen.getByTestId('field-cleanup-ask'));

        await click(screen.getByTestId('field-cleanup-reject'));

        expect((screen.getByTestId('field-seed') as HTMLTextAreaElement).value).toBe(
            'a cartographer maps the sea that ate her fleet'
        );
        expect(screen.queryByTestId('field-cleanup-proposal')).toBeNull();

        // The other way out: every keystroke retires the answer, because `source_hash` binds it to the draft the
        // pass actually read.
        await click(screen.getByTestId('field-cleanup-ask'));

        expect(screen.getByTestId('field-cleanup-proposal').textContent).toBe(proposal.text);

        await type(screen.getByTestId('field-seed'), 'a cartographer maps the sea that ate her fleet, badly');

        expect(screen.queryByTestId('field-cleanup-proposal')).toBeNull();
    });

    it('prints a guard refusal as the answer it is, with nothing to take (AC3)', async () => {
        await renderShell(<NewStoryForm />, [], [], {
            requestSeedCleanupDraft: vi.fn(async (): Promise<SeedCleanupProposal> => ({
                ok: false,
                source_hash: '9b8387ee',
                refusal: 'numbers_lost'
            }))
        });

        await writeTitleAndSeed();
        await type(screen.getByTestId('field-phrase'), PLOTLINES_ROW.key);
        await click(screen.getByTestId('field-cleanup'));
        await click(screen.getByTestId('field-cleanup-ask'));

        expect(screen.getByTestId('field-cleanup-refusal').textContent).toBe(seedCleanupRefusalNotice('numbers_lost'));
        expect(screen.queryByTestId('field-cleanup-accept')).toBeNull();
        expect(screen.queryByTestId('field-cleanup-proposal')).toBeNull();
        // The draft in the box is still the Author's, and the request SUCCEEDED — so there is no error strip.
        expect((screen.getByTestId('field-seed') as HTMLTextAreaElement).value).toBe(
            'a cartographer maps the sea that ate her fleet'
        );
    });

    it('leaves no proposal when the route refused, and puts the server’s sentence in the shell’s line (L-13)', async () => {
        const { store } = await renderShell(<NewStoryForm />, [], [], {
            requestSeedCleanupDraft: vi.fn(async (): Promise<never> => {
                throw new ApiError(409, 'this server has no model transport wired into its route table');
            })
        });

        await writeTitleAndSeed();
        await type(screen.getByTestId('field-phrase'), PLOTLINES_ROW.key);
        await click(screen.getByTestId('field-cleanup'));
        await click(screen.getByTestId('field-cleanup-ask'));

        expect(screen.queryByTestId('field-cleanup-proposal')).toBeNull();
        expect(store.getSnapshot().error).toBe('this server has no model transport wired into its route table');
    });

    it('drops an answer whose draft has moved on, rather than offering a proofread of other text', async () => {
        // The slow answer arrives AFTER the Author kept typing: `source_hash` binds the proposal to the bytes the
        // pass read, so showing it over a moved box would offer to replace text with a suggestion computed on
        // something else. The verb is deferred by a microtask, and the keystroke lands inside it.
        let resolveAnswer: ((proposal: SeedCleanupProposal) => void) | undefined;
        const { store } = await renderShell(<NewStoryForm />, [], [], {
            requestSeedCleanupDraft: vi.fn(
                () =>
                    new Promise<SeedCleanupProposal>((resolve) => {
                        resolveAnswer = resolve;
                    })
            )
        });

        await writeTitleAndSeed();
        await type(screen.getByTestId('field-phrase'), PLOTLINES_ROW.key);
        await click(screen.getByTestId('field-cleanup'));
        await click(screen.getByTestId('field-cleanup-ask'));

        // The ask is in flight: the button says so, and a second press cannot start another read of the same brief.
        expect((screen.getByTestId('field-cleanup-ask') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('field-cleanup-ask').textContent).toBe('The Editor is reading…');

        await type(screen.getByTestId('field-seed'), 'a cartographer maps the sea that ate her fleet, and the tide');
        resolveAnswer!({ ok: true, source_hash: '9b8387ee', text: 'the answer nobody asked for', changed: true });
        // The verb's continuation runs on the microtask queue; this await is what lets it land.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(screen.queryByTestId('field-cleanup-proposal')).toBeNull();
        expect((screen.getByTestId('field-seed') as HTMLTextAreaElement).value).toBe(
            'a cartographer maps the sea that ate her fleet, and the tide'
        );
        expect(store.getSnapshot().error).toBeNull();
    });

    it('retires the answer when the switch is turned off, so a closed ask cannot be taken', async () => {
        const proposal: SeedCleanupProposal = { ok: true, source_hash: '9b8387ee', text: 'edited', changed: true };

        await renderShell(<NewStoryForm />, [], [], {
            requestSeedCleanupDraft: vi.fn(async (): Promise<SeedCleanupProposal> => proposal)
        });

        await writeTitleAndSeed();
        await type(screen.getByTestId('field-phrase'), PLOTLINES_ROW.key);
        await click(screen.getByTestId('field-cleanup'));
        await click(screen.getByTestId('field-cleanup-ask'));

        expect(screen.getByTestId('field-cleanup-proposal').textContent).toBe('edited');

        await click(screen.getByTestId('field-cleanup'));

        expect(screen.queryByTestId('field-cleanup-panel')).toBeNull();
        expect((screen.getByTestId('field-seed') as HTMLTextAreaElement).value).toBe(
            'a cartographer maps the sea that ate her fleet'
        );
    });
});
