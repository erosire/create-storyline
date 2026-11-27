// R7 (this wave) — the one-shot Seed cleanup: the proposal, the transport shape, and the three guards.
//
// WHAT THIS FILE PINS, and why each one is a test rather than a comment:
//
//   1. THE TRANSFORM PRESERVES SUBSTANCE (AC3). The cleanup is the Editor's pass over the AUTHOR'S text,
//      so the interesting failure is not "the model answered" but "the model rewrote the book". Every case
//      states the input and the exact outcome object, and the passing case uses a grammatically broken
//      brief whose cleaned form differs from the source in grammar alone — the number train, the length
//      envelope and the `changed` flag are all asserted together, so a proposal that quietly dropped a
//      chapter count cannot pass by being well written.
//   2. THE CALL IS A PROJECTION, NOT A RUN. The exact `ChatRequest` is asserted off the mock's recorded
//      call: ONE call, two turns, `tools: []`, no `responseFormat`. A cleanup that reached for a tool could
//      write a record before the Author confirmed anything (P10 / L-19), and the transport shape is the only
//      place that promise is observable — the module takes no `Store`, so it structurally cannot write.
//   3. A REJECTED CLEANUP IS A NO-OP. Every guard answers `{ok:false, refusal}` and leaves `source` intact;
//      none of them throws, and the empty-source case answers WITHOUT calling the model. The caller keeps
//      the Author's own text in every one of these states, which is the property the desk relies on.
//
// WHAT THIS FILE DOES NOT EXERCISE, stated so the record stays honest: no live provider answers here — the
// double does — so these tests pin the CALL SHAPE and the GUARDS, not any model's proofreading quality. The
// semantic check ("is this still the brief I wrote?") is the Author's confirmation, which no vitest run can
// stand in for. The single write the confirmation leads to is pinned in `api/phrase-start-routes.test.ts`.
import { describe, expect, it } from 'vitest';
import { MockChatClient, msg } from '../llm/mock';
import { proposeSeedCleanup, SEED_CLEANUP_SYSTEM } from './seed-cleanup';
import type { ChatClient, ChatResponse } from '../llm';

// THE BROKEN BRIEF, one an Author would actually paste: two agreement errors, a doubled subject, and the
// one fact a chapter plan turns on — SIX charts, written as a digit so the number guard has something to hold.
const BROKEN =
    'A mapmaker she find her own coastline redrawn on a chart she survey herself, and she need 6 charts to prove it to the harbour board that never trusted her.';

// THE CLEANED BRIEF, known in advance: the same two sentences, grammar fixed, every word of substance in the
// same order. Both are 155 characters, so the envelope cannot be what makes this case pass.
const CLEAN =
    'A mapmaker finds her own coastline redrawn on a chart she surveyed herself, and she needs 6 charts to prove it to the harbour board that never trusted her.';

// FNV-1a over `BROKEN`, captured from `shared/seed-hash.ts:seedHashOf` rather than guessed — the same value
// the Start verb's copied seed will carry, because both hash the SAME trimmed text.
const BROKEN_HASH = '9b8387ee';

/** The user turn the pass must send, spelled out once so every request assertion names the exact bytes. */
const USER_TURN = `Proofread this brief.\n\n--- BEGIN BRIEF ---\n${BROKEN}\n--- END BRIEF ---`;

/** A client that answers with fixed prose and records the request. */
const answering = (content: string): MockChatClient => new MockChatClient(() => ({ message: msg({ content }) }));

describe('proposeSeedCleanup — the cleanup is one tool-less turn, and its request is the promise', () => {
    it('asks the model exactly once, with no tools and no answer schema (P10: a proposal cannot write)', async () => {
        const chat = answering(CLEAN);

        // AC3, the passing arm: a brief with real grammar errors comes back with the grammar fixed and the
        // substance intact — asserted as the WHOLE outcome object, not as "the text changed".
        expect(await proposeSeedCleanup({ chat, model: 'mock-gpt' }, BROKEN)).toEqual({
            ok: true,
            source: BROKEN,
            source_hash: BROKEN_HASH,
            text: CLEAN,
            changed: true
        });

        // ONE call. A second turn would mean the pass is conversing with itself, which is a run, and a run
        // is a row the Author never asked for.
        expect(chat.callCount).toBe(1);
        expect(chat.calls[0]).toEqual({
            model: 'mock-gpt',
            messages: [
                { role: 'system', content: SEED_CLEANUP_SYSTEM },
                { role: 'user', content: USER_TURN }
            ],
            // `tools: []` is the promise: the pass cannot call `editSummary`, `structurePlotlines` or
            // anything else, so nothing it produces can reach a record before the Author confirms (D-72).
            tools: [],
            temperature: 0
        });
        // And it asked for no answer schema: the answer IS the text, so a `responseFormat` would only give
        // the model a way to wrap the brief in an envelope the Seed would then carry.
        expect(chat.calls[0].responseFormat).toBeUndefined();
    });

    it('trims the brief before anything else, so the proposal and the confirm are one text', async () => {
        const chat = answering(CLEAN);

        expect(await proposeSeedCleanup({ chat, model: 'mock-gpt' }, `   \n${BROKEN}\n  `)).toEqual({
            ok: true,
            source: BROKEN,
            source_hash: BROKEN_HASH,
            text: CLEAN,
            changed: true
        });
        // The model sees the trimmed text, not the padding: this is the same trim the `custom` Start arm
        // applies, so confirming this proposal writes these exact bytes and no whitespace.
        expect(chat.calls[0].messages[1].content).toBe(USER_TURN);
    });

    it('reports "nothing to fix" as a result rather than a refusal, and says the text is unchanged', async () => {
        const chat = answering(BROKEN);

        expect(await proposeSeedCleanup({ chat, model: 'mock-gpt' }, BROKEN)).toEqual({
            ok: true,
            source: BROKEN,
            source_hash: BROKEN_HASH,
            text: BROKEN,
            changed: false
        });
    });

    it('strips a code fence, which is the only normalisation an answer gets before the guards', async () => {
        const chat = answering(`\`\`\`text\n${CLEAN}\n\`\`\``);

        expect(await proposeSeedCleanup({ chat, model: 'mock-gpt' }, BROKEN)).toEqual({
            ok: true,
            source: BROKEN,
            source_hash: BROKEN_HASH,
            text: CLEAN,
            changed: true
        });
    });

    it('leaves an unterminated fence alone rather than eating the last character of the prose', async () => {
        // The fence-opening line goes and the closing index is -1. Dropping the last character here would
        // shorten a valid answer for a provider formatting bug, and `her.` is part of the brief.
        const chat = answering(`\`\`\`\n${CLEAN}`);

        expect(await proposeSeedCleanup({ chat, model: 'mock-gpt' }, BROKEN)).toEqual({
            ok: true,
            source: BROKEN,
            source_hash: BROKEN_HASH,
            text: CLEAN,
            changed: true
        });
    });
});

describe('proposeSeedCleanup — the guards reject a rewrite instead of proposing it (AC3)', () => {
    it('refuses an answer that lost a number: six charts became "several charts"', async () => {
        // The rewrite is GRAMMATICAL, the same length, and reads better — which is exactly why the number
        // train is checked BEFORE the length envelope. A chapter plan built on "several" is the Author's
        // fact, gone, and a confirmation screen would show pretty prose rather than the lost digit.
        const chat = answering(
            'A mapmaker finds her own coastline redrawn on a chart she surveyed herself, and she needs several charts to prove it to the harbour board that never trusted her.'
        );

        expect(await proposeSeedCleanup({ chat, model: 'mock-gpt' }, BROKEN)).toEqual({
            ok: false,
            source: BROKEN,
            refusal: 'numbers_lost'
        });
    });

    it('refuses an answer that condensed the brief (a summary is not a proofread)', async () => {
        // 49 characters against a 155-character source, so the floor is 93 and the digit SURVIVES — the only
        // thing that can refuse this is the envelope. `too_short` and `numbers_lost` stay separate answers
        // on purpose: the desk says which kind of rewrite happened.
        const chat = answering('A mapmaker needs 6 charts to prove she was right.');

        expect(await proposeSeedCleanup({ chat, model: 'mock-gpt' }, BROKEN)).toEqual({
            ok: false,
            source: BROKEN,
            refusal: 'too_short'
        });
    });

    it('refuses an answer that added material the Author never wrote', async () => {
        // The cleaned brief (155) plus an invented sentence about the harbour master: 223 against a ceiling
        // of 193.75. Every number is intact and the prose is fine, so the ceiling is the only thing standing
        // between this and the phrase seed.
        const chat = answering(`${CLEAN} The harbour master keeps a lighthouse that no ship has ever needed.`);

        expect(await proposeSeedCleanup({ chat, model: 'mock-gpt' }, BROKEN)).toEqual({
            ok: false,
            source: BROKEN,
            refusal: 'too_long'
        });
    });

    it('refuses an empty answer without pretending the brief became empty', async () => {
        const chat: ChatClient = {
            async complete(): Promise<ChatResponse> {
                return { message: {} };
            }
        };

        expect(await proposeSeedCleanup({ chat, model: 'mock-gpt' }, BROKEN)).toEqual({
            ok: false,
            source: BROKEN,
            refusal: 'empty_answer'
        });
    });

    it('answers an empty brief with no model call at all (the Start verb refuses it anyway)', async () => {
        const chat = answering(CLEAN);

        expect(await proposeSeedCleanup({ chat, model: 'mock-gpt' }, '   \n  ')).toEqual({
            ok: false,
            source: '',
            refusal: 'empty_answer'
        });
        // Zero calls: the blank case is decided before the transport, so a desk that asks on an empty field
        // spends nothing and can show its own "write the Seed first" line instead.
        expect(chat.callCount).toBe(0);
    });
});
