// R7 (this wave) — THE ONE-SHOT SEED CLEANUP: the Editor's grammar/typo pass over a Phrase-② Seed the
// Author supplied, produced BEFORE the start and confirmed by the Author before anything is written.
//
// WHY THIS FILE EXISTS AT ALL. The recorded decision is "Editor normalizes the seed once, at start, with
// Author confirm": a Phrase-② Seed that came FROM THE AUTHOR DIRECTLY (`source: 'custom'`) may carry the
// typos of a typed brief, and the crew would then plan chapters against text nobody cleaned up. A Seed
// COMPILED from Phrase ① never comes here at all — that text was written and reviewed by the crew, so a
// cleanup pass on it is a model call buying nothing (AC2).
//
// WHY A PROPOSAL AND NOT AN EDIT (P10 / L-19). An Editor writes no story prose, so this pass may not
// touch a record: it returns TEXT and writes nothing. The precedent is the phase-① Seed Brief, where
// "Clean up and structure' is a projection, not an edit" (`documents/phase-1-research-pipeline.md:73`)
// — the derived text rides beside the Seed, never over it, and the Author's confirmation is the step that
// turns it into the Seed. That is also why the answer is not persisted here: this module takes NO `Store`,
// so it structurally cannot write. `phrases.seed` is still written exactly ONCE, by the Start commit, with
// the bytes the Author confirmed (D-72's copy), and D-76/§18.13's "no verb replaces the seed after the
// start" stays intact because the confirm happens BEFORE the row exists.
//
// WHY A DIRECT `chat.complete` AND NOT A RUN. A run is a Work Item, a `runs` row, a thread and a report
// (D-18/S-1), and none of that describes a desk-time suggestion the Author may throw away. This is one
// assistant turn with `tools: []` — the same tool-less execution mode §2/3 of the research-pipeline
// record established for the sampling Writer (`toolMode: 'none'`: an execution mode, not a permission
// change). It is the cheapest shape the existing transport already answers, and it invents no job kind,
// no queue entry and no new tool.
//
// WHY THE ANSWER IS GUARDED RATHER THAN TRUSTED. A model asked to "fix grammar" happily rewrites. Three
// mechanical checks decide whether the answer is still the Author's brief, and anything they reject is
// reported as NO PROPOSAL (`undefined`) so the caller keeps the Author's own text — a rejected cleanup is
// a no-op, never a worse Seed:
//   1. NON-EMPTY — a blank answer cannot replace a non-empty brief;
//   2. THE NUMBER TRAIN IS INTACT — every number in the source appears, in order, in the proposal. A
//      grammar pass never drops a chapter count, a date or an age, so a dropped digit means the model
//      summarised, and substance is exactly what the Author is being asked to confirm;
//   3. THE LENGTH ENVELOPE — a proposal much SHORTER than the source condensed it, and one much LONGER
//      invented material. Neither is grammar.
// Semantic fidelity is NOT machine-decided: that is the Author's confirmation, which is the whole point of
// the recorded decision. The guards only reject the rewrites no confirmation would have caught.
import type { ChatClient, ChatRequest } from '../llm';
import { seedHashOf } from '../../shared/seed-hash';

// ---------------------------------------------------------------------------
// The prompt — fixed bytes, so a desk-time pass reads the same on every Story
// ---------------------------------------------------------------------------

/**
 * The system turn: what may change, and what may not. It says "return the text" rather than "return a
 * summary", and it names the OUTPUT SHAPE first, because a one-shot with no tools has no schema to lean
 * on and a preamble in the answer would otherwise become part of the Seed.
 */
export const SEED_CLEANUP_SYSTEM =
    'You proofread one paragraph of a novelist\u2019s brief. Fix grammar, spelling, punctuation and obvious ' +
    'typos, and nothing else. Never add a fact, drop a fact, reorder sentences, merge or split paragraphs, ' +
    'or restate a sentence for style: the brief is the Author\u2019s decision about their book, and you are not ' +
    'editing it. Keep every name, number and place exactly as written. If nothing needs fixing, return the ' +
    'text unchanged. Output ONLY the text \u2014 no preamble, no explanation, no quotation marks, no code fence.';

/** The user turn: the brief, verbatim, framed as the text to proofread. */
export const seedCleanupUserPrompt = (seed: string): string =>
    `Proofread this brief.\n\n--- BEGIN BRIEF ---\n${seed}\n--- END BRIEF ---`;

// ---------------------------------------------------------------------------
// The guards — the three mechanical checks described in the header
// ---------------------------------------------------------------------------

/** Below this share of the source's length the answer condensed the brief rather than proofread it. */
export const SEED_CLEANUP_MIN_RATIO = 0.6;

/** Above this share of the source's length the answer added material the Author never wrote. */
export const SEED_CLEANUP_MAX_RATIO = 1.25;

/** Every number in the text, in order, as written — the substance train a proofread must leave alone. */
const numberTrain = (text: string): string[] => text.match(/\d+(?:[.,]\d+)*/g) ?? [];

/**
 * What a provider may wrap a plain-text answer in. One model fenced the cleaned brief in ```text and the
 * fence would otherwise travel into `phrases.seed` at the confirm, which is a character the Author never
 * typed; stripping it is the ONLY text normalisation this module performs, and it happens before the
 * guards so a fenced answer is judged on its prose.
 */
const stripAnswerFence = (answer: string): string => {
    const trimmed = answer.trim();

    if (!trimmed.startsWith('```')) return trimmed;

    // Drop the opening fence (with its optional language tag) and the closing one. A model that opened a
    // fence and never closed it leaves the closing index at -1, and `slice(0, -1)` would eat the last
    // character of the prose — so an unterminated fence drops only the opening line.
    const body = trimmed.slice(trimmed.indexOf('\n') + 1);
    const closing = body.lastIndexOf('```');

    return (closing === -1 ? body : body.slice(0, closing)).trim();
};

/** Why there is no usable proposal, in the sentence the desk shows. Nothing here is a failure to retry. */
export type SeedCleanupRefusal = 'empty_answer' | 'numbers_lost' | 'too_short' | 'too_long';

/** The Author's text plus the model's suggestion, or the reason the suggestion was thrown away. */
export type SeedCleanupOutcome =
    | { ok: true; source: string; source_hash: string; text: string; changed: boolean }
    | { ok: false; source: string; refusal: SeedCleanupRefusal };

export interface SeedCleanupDeps {
    /** The transport. Injected, so the desk's tests run on the scripted client rather than a live provider. */
    chat: ChatClient;
    /** The model the call asks for — the host's default, the same value the run layer is given. */
    model: string;
}

/**
 * The one request this pass sends: two turns, no tools, no answer schema.
 *
 * `tools: []` is deliberate rather than an omitted field (§2/3 of the research-pipeline record): an
 * omitted `tools` leaves the offer to the transport, and a proofread has nothing to call. There is no
 * `responseFormat` either — the answer IS the text, and a schema would only invite the model to wrap it.
 */
export const seedCleanupRequest = (model: string, seed: string): ChatRequest => ({
    model,
    messages: [
        { role: 'system', content: SEED_CLEANUP_SYSTEM },
        { role: 'user', content: seedCleanupUserPrompt(seed) }
    ],
    tools: [],
    temperature: 0
});

/**
 * Asks for the cleanup. One call, one answer, no writes.
 *
 * The source is TRIMMED before anything else, because the Start verb trims the `custom` text too
 * (`routes.ts`, the `custom` arm): hashing, comparing and proposing over the same trimmed bytes is what
 * makes "the proposal" and "the Seed the confirm would write" one text rather than two.
 *
 * An EMPTY source answers `refusal: 'empty_answer'` without asking the model at all — a blank brief is the
 * Start verb's 400, and a call would be spent on nothing.
 */
export async function proposeSeedCleanup(deps: SeedCleanupDeps, seed: string): Promise<SeedCleanupOutcome> {
    const source = seed.trim();
    const sourceHash = seedHashOf(source);

    if (source === '') return { ok: false, source, refusal: 'empty_answer' };

    const response = await deps.chat.complete(seedCleanupRequest(deps.model, source));
    const answer = stripAnswerFence(response.message.content ?? '');

    if (answer === '') return { ok: false, source, refusal: 'empty_answer' };

    // GUARD 2 — the number train. `3 chapters` becoming `several chapters` is the exact rewrite the Author
    // would not notice in a wall of corrected prose, and it is the one thing a chapter plan turns on.
    const sourceNumbers = numberTrain(source);

    if (sourceNumbers.length > 0 && numberTrain(answer).join(' ') !== sourceNumbers.join(' ')) {
        return { ok: false, source, refusal: 'numbers_lost' };
    }

    // GUARD 3 — the envelope, measured against the source's own length so a two-line brief and a
    // two-page one are judged by the same rule.
    if (answer.length < source.length * SEED_CLEANUP_MIN_RATIO) {
        return { ok: false, source, refusal: 'too_short' };
    }

    if (answer.length > source.length * SEED_CLEANUP_MAX_RATIO) {
        return { ok: false, source, refusal: 'too_long' };
    }

    // `changed: false` is a RESULT, not a refusal: "there was nothing to fix" is the answer the Author
    // asked for, and the desk says so instead of offering identical text as a suggestion.
    return { ok: true, source, source_hash: sourceHash, text: answer, changed: answer !== source };
}
