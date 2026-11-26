// Phase-1 prompt compiler acceptance (documents/phase-1-research-pipeline.md §5).
//
// WHY THE ASSERTIONS ARE EXACT STRINGS: `prompt_hash` is the audit key a Revision row carries (§3.5)
// and the reason a provider can serve the sampling prefix from cache (§5). Both promises die the
// moment the text is allowed to drift, so the fixture below pins the WHOLE `system` and `user`
// turns — not a "contains the heading" sniff that would pass while the bytes changed.
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import {
    compileGroupDraftPrompt,
    compileGroupLockPrompt,
    compileGroupReviewPrompt,
    compileSamplePrompt,
    compileScreenPrompt,
    compileSectionScorePrompt,
    hashPhase1Prompt,
    renderFixTask,
    SCORE_TEMPLATE_SLUG
} from './phase1-prompt';
import { AUTHOR_ATTR, seedFinding, seedStory, seedTask, seedTemplate } from './mock';
import { ensurePhraseCatalog } from '../phrase/catalog';
import { groupCheckSeatKey } from '../phrase/exclusion';
// R-lock: the test fixtures lock groups through the DOMAIN operation, not by patching the row, so a
// fixture cannot invent a lock state the write itself refuses to produce (`already_locked`, an unwritten
// group, an Editor without the Setting).
import { lockPhraseGroup } from '../phrase/locks';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { cleanSelectionOf, stampCleanRevisions } from '../phrase/reviewed';
import { recordUidAt } from '../store/persist';
import { phraseGroupDefinition } from '../../shared/phrase';
import type { PhraseGroup, Story } from '../../shared/types';

/**
 * The state a sampling round arrives at: a Story in phase ①, both Phase-1 templates, ONE accepted
 * Seed Brief, two prompt-worthy Knowledge entries (critical + high) and one that must stay out
 * (normal), the round-1 SELECTED draft, two open fix tasks and one closed one.
 *
 * Ids are the store's own (`story_1`, `revision_1`, `revision_2`, `task_1`, `task_2`, `task_3`),
 * which is what makes the exact strings below checkable by eye.
 */
function seedPhase1Store() {
    const store = Store.empty();
    const story = seedStory(store, {
        phase: 'summary',
        idea: 'A cartographer returns to the valley she mapped as a girl.'
    });

    seedTemplate(store, {
        name: 'writer-summary-sampler',
        roles: [
            {
                name: 'writer',
                kind: 'writer',
                prompt: 'You are the Writer for phase ① in sampling mode. Answer with ONE JSON object.'
            }
        ],
        serves_phase: ['summary']
    });

    seedTemplate(store, {
        name: 'critic-screening',
        roles: [
            {
                name: 'critic',
                kind: 'critic',
                prompt: 'You are the screening Critic for phase ①. Report ONLY critical and high problems.'
            }
        ],
        serves_phase: ['summary']
    });

    store.seedBriefs.create(
        {
            story_id: story.id,
            seed_hash: 'abcd1234',
            logline: 'A cartographer finds her map is wrong.',
            protagonist: 'Maren',
            want: 'to prove the map',
            need: 'to accept the water',
            obstacle: 'the reservoir',
            stakes: 'her memory',
            setting: 'a drowned valley, 1963',
            world_rules: ['no magic', 'the reservoir is engineering'],
            promise: 'map and territory reconcile',
            tone_hints: 'cold, precise',
            constraints: ['no flashbacks'],
            open_questions: ['who flooded the valley?'],
            status: 'accepted'
        },
        AUTHOR_ATTR
    );

    // Created high-first so the compiler's sort — not the insertion order — is what the
    // assertion below proves (`critical` before `high`, then by fingerprint).
    store.knowledge.create(
        {
            story_id: story.id,
            kind: 'period',
            topic: 'revolver',
            claim: '1880 revolvers hold six rounds.',
            detail: 'single action',
            importance: 'high',
            sources: [{ url_or_title: 'https://example.test/revolver', claim: 'six rounds', accessed_at: '1963-01-01' }],
            fingerprint: 'K-bbb',
            seen_count: 1,
            author: 'researcher'
        },
        AUTHOR_ATTR
    );

    store.knowledge.create(
        {
            story_id: story.id,
            kind: 'place',
            topic: 'harbour',
            claim: 'The harbour freezes in January.',
            importance: 'critical',
            sources: [
                { url_or_title: 'Atlas', claim: 'freezes', accessed_at: '1963-01-01' },
                { url_or_title: 'Almanac', claim: 'January', accessed_at: '1963-01-01' }
            ],
            fingerprint: 'K-aaa',
            seen_count: 1,
            author: 'researcher'
        },
        AUTHOR_ATTR
    );

    // `normal` never enters a sampling prefix (§5); it stays for `readKnowledge`.
    store.knowledge.create(
        {
            story_id: story.id,
            kind: 'fact',
            topic: 'coin',
            claim: 'A shilling was twelve pence.',
            importance: 'normal',
            sources: [],
            fingerprint: 'K-ccc',
            seen_count: 1,
            author: 'researcher'
        },
        AUTHOR_ATTR
    );

    const base = store.revisions.create(
        {
            story_id: story.id,
            unit_kind: 'summary',
            unit_ref: 'summary_1',
            body: {
                fields: {
                    premise: 'A return to a mapped valley.',
                    promise: 'The map reconciles.',
                    theme: 'Memory against measurement.',
                    tone: 'Plain.',
                    ending: 'She floods it.',
                    world_rules: 'No magic.'
                }
            },
            run_ref: 'run_2',
            state: 'selected',
            verdict_refs: [],
            round: 1
        },
        AUTHOR_ATTR
    );

    // H1/R1 — the task the round must answer CARRIES its finding. A title says what to change; the
    // finding's detail and evidence say what was actually wrong and where the proof is, and the
    // criterion's `fix_hint` says what done looks like. A refinement sample that only sees the title
    // redrafts the paragraph instead of repairing the defect, which is the bug H1 closes.
    const defect = seedFinding(store, story.id, {
        target_ref: 'summary_1',
        criterion_ref: 'C-14',
        title: 'the ending does not pay the promise',
        detail: 'nothing in the ending pays the promise the brief makes',
        evidence: 'ending: She floods it. — no choice of the protagonist brings map and territory together',
        state: 'confirmed',
        related_refs: [base.id]
    });

    seedTask(store, story.id, {
        kind: 'fix',
        title: 'pay the promise',
        detail: 'the ending does not pay it',
        priority: 30,
        criterion_ref: 'C-14',
        finding_ref: defect.id
    });
    // Priority 10 sorts AFTER priority 30 (priority DESC), and the id breaks a tie.
    seedTask(store, story.id, { kind: 'fix', title: 'name the river', priority: 10, criterion_ref: 'C-15' });
    // A closed task is not a fix task in front of this draft.
    seedTask(store, story.id, { kind: 'fix', title: 'done one', priority: 99, state: 'done' });

    const target = store.revisions.create(
        {
            story_id: story.id,
            unit_kind: 'summary',
            unit_ref: 'summary_1',
            body: {
                fields: {
                    premise: 'Maren returns.',
                    promise: 'She floods it.',
                    theme: 'Loss.',
                    tone: 'Cold.',
                    ending: 'Water.',
                    world_rules: 'Engineering.'
                }
            },
            run_ref: 'run_3',
            state: 'drafted',
            verdict_refs: [],
            round: 2
        },
        AUTHOR_ATTR
    );

    return { store, story, base, target };
}

/**
 * The Seed Brief exactly as both prompts render it — the block every case below starts with.
 *
 * T3 appended the engine-owned SEED CONTRACT NOTE: the Seed/Brief commits what it STATES, and the open
 * part is the Writer's to fill with compatible specifics. It is part of the cached prefix, so the mirror
 * below is byte-checked like everything else (`SEED_SILENCE_RULE` pins its doctrine clauses on a run with
 * a CUSTOM role prompt, where only the engine's text remains).
 */
const SEED_BRIEF_BLOCK = `## SEED BRIEF
seed_hash: abcd1234
logline: A cartographer finds her map is wrong.
protagonist: Maren
want: to prove the map
need: to accept the water
obstacle: the reservoir
stakes: her memory
setting: a drowned valley, 1963
world_rules:
- no magic
- the reservoir is engineering
promise: map and territory reconcile
tone_hints: cold, precise
constraints:
- no flashbacks
open_questions:
- who flooded the valley?
(The Seed Brief commits what it STATES; it is not an outline of everything the book must contain. Where it is silent, or a question is listed in \`open_questions\`, the Writer may supply any specific that stays compatible with it — an added place, consequence, stake or custom the Seed never named. That freedom is the job, not a defect: no pass may ask the Summary for foreshadowing, stakes or exhaustive detail that neither the Seed nor the Summary itself promised. A claim that CONTRADICTS the brief, or a commitment it states explicitly that the draft does not carry, is still the failure this level is graded on.)`;

/** Knowledge as the sampling prefix renders it: critical first, sources joined by '; '. */
const KNOWLEDGE_BLOCK = `## KNOWLEDGE — critical and high only
[K-aaa · critical · place] harbour: The harbour freezes in January. — source: Atlas; Almanac
[K-bbb · high · period] revolver: 1880 revolvers hold six rounds. (single action) — source: https://example.test/revolver`;

/** The round-1 selected draft, rendered by the same `renderSummaryBody` both prompts use. */
const BASE_DRAFT_BLOCK = `premise: A return to a mapped valley.
promise: The map reconciles.
theme: Memory against measurement.
tone: Plain.
ending: She floods it.
world_rules: No magic.`;

/**
 * H1/R1 — the fix block, pinned verbatim. A title alone is what a refinement sample used to get, and
 * a Writer holding only a title rewrites the paragraph instead of repairing the defect; the finding's
 * `defect`/`evidence` lines and the criterion's `done looks like` are what make the smallest correct
 * change possible, and the id in brackets is what the screening certificate answers by (H1/R2).
 */
const FIX_TASK_BLOCK = `[task_0 · priority 30 · finding_0] pay the promise
  work: the ending does not pay it
  defect: nothing in the ending pays the promise the brief makes
  evidence: ending: She floods it. — no choice of the protagonist brings map and territory together
  criterion: C-14
  done looks like: Remove what contradicts the Seed, repair what contradicts the Summary’s own promise, and add only a commitment the Seed states explicitly that the Summary does not carry; what the Seed leaves open is the Writer’s to fill with any compatible detail, so its absence is not a defect to fix (P5: the Seed is never edited to pass).
[task_1 · priority 10] name the river
  done looks like: Run verifyIdea (re-read the source, record evidence) before the lock, or keep the unverified Idea out of the artifact (D-27).`;

/**
 * H1/R6 + T3 — the screening contract, pinned verbatim. Two calibrations live in this one engine-owned
 * string, and both exist because a screening pass has no downstream pass to dispute it: its issues rank
 * the sample on the spot (§6.5).
 *
 * R6 killed the PHRASING complaint (`high` for a comma, then a resample, then another Critic who disliked
 * the new wording — the hill with no top). T3 killed the ABSENCE complaint: the Author's two screenshots
 * were a refuge with no earlier planting in the Summary and a stake the Seed never stated, and the line
 * this replaces ("A high fails to deliver something the Seed Brief promises") read a general Seed as an
 * outline with unfilled boxes. The rule now names invention as allowed and makes the quote the test: an
 * absence cannot be quoted, so it is not admissible. The contradiction grounds stay, and so does the
 * requirement to name the field — this array is what the selection is gated on.
 *
 * THE `detail` CLAUSE (the schema-required field the sentence now names): the last sentence used to stop
 * at "name the field in `location`, cite `C-14`… in `criterion`", so the one field the answer schema makes
 * NON-OPTIONAL (`shared/schemas/group-review.ts:102,127` — `detail: { type: 'string', minLength: 1 }`, in
 * `required`) was never asked for in the engine-owned wording, and a Critic that quoted a line without
 * saying what is wrong with it still bought a valid, unusable answer. The clause lives here, in the mirror,
 * because a reword that drops `detail` has to fail this file: the prompt and the schema are ONE contract,
 * and `run/prompt-schema-parity.test.ts` checks the same pairing from the schema side. Phrase ②'s twin
 * (`phase1-prompt.ts:CONTRACT_SCREEN_INSTRUCTION`) carries the same clause plus the engine-owned
 * `group_refs`/`group_quotes` coverage rule; its byte pins live in the phrase-② seats
 * (`integration/plotlines-groups.test.ts`), not in this Summary-lane file.
 */
const SCREEN_CONTRACT =
    'Report ONLY critical and high issues, and reserve those two words for what a Summary has to get RIGHT: ' +
    'a critical contradicts the Seed Brief or a critical Knowledge entry — a causal chain that does not cause, ' +
    'a timeline that cannot happen, a world rule the draft states and then breaks, a motive that does not explain ' +
    'the acts it grounds, or an ending that fails the Seed’s goal. A high leaves unpaid a commitment the ' +
    'Seed Brief states EXPLICITLY. The Seed is general and is not an outline: where it is silent, or names a ' +
    'question in `open_questions`, the Writer may invent any specific that does not contradict it. So an added ' +
    'detail, a Seed question left open, stakes or consequences the Seed never stated, and setup the Summary did ' +
    'not promise are NOT issues, and never a `C-14` issue — reporting one costs this sample a comparison it ' +
    'should have won. What stays reportable is a contradiction — of the Seed, of critical Knowledge, or inside the ' +
    'draft itself — and a commitment the Seed states centrally the draft plainly does not carry. Proof is a ' +
    'quotation: an issue that can quote only an absence, and not what the draft contradicts, is an invalid answer. ' +
    'Word choice, sentence structure, grammar, register and a preference for another phrasing of the same ' +
    'commitment are NOT issues at this phase — they are minor, nothing here ranks them, and the prose that carries ' +
    'them is written and judged in phase ③. Quote the offending field verbatim in `quote`, name the field in ' +
    '`location`, say in `detail` what is wrong and where, and cite `C-14`, `C-15` or `seed` in `criterion`. Return {"issues":[]} when the draft holds.';

/**
 * H1/R2 — the fix-verification contract. `resolved` needs a quotation from the target draft, and a
 * rephrasing is explicitly not a resolved fix: this text is what the selection is gated on
 * (`loop/sample-select.ts:scoreSample`), so a loose word here buys a candidate that fixed nothing.
 */
const FIX_VERIFY_CONTRACT =
    'The FIX TASKS section above names the changes this draft was asked to make. Answer with one ' +
    '`fix_verifications` entry for EVERY task it lists, and none for anything else: `fix_ref` is the task id ' +
    'inside the brackets, and `status` is `resolved` only when the draft now does what the task asks — quote ' +
    'the words of the draft that show it in `evidence` — `unresolved` when the defect the task describes is ' +
    'still there, and `unknown` when the draft neither shows the fix nor contradicts it. A different phrasing of ' +
    'the same commitment is not a resolved fix: judge the fact the task named, not the sentence that carries it. ' +
    'An `evidence` line you cannot fill from the draft is not a verdict — answer `unknown`.';

/**
 * HILL CLIMB — the mirror of `phase1-prompt.ts:ISSUE_ORIGIN_INSTRUCTION`, byte for byte. It rides the
 * COMPARISON (a screen that was handed the accepted draft), not the fix list: the Critic can classify a
 * defect as inherited or introduced only when the accepted draft is in front of it, and a round-1 screen
 * has no accepted draft to be inherited FROM (R5). The fix certificate stays with the fix list, so the
 * two halves separate exactly when the queue empties out from under a round (H2/R2).
 */
const ISSUE_ORIGIN_INSTRUCTION =
    'Every issue you report also names its `origin`: `inherited` when that same defect is already in the ' +
    'SELECTED DRAFT above, or `introduced` when the target draft below created it. The accepted draft is in ' +
    'front of you precisely so you can tell the two apart — a flaw the accepted draft already had is not ' +
    'this draft’s doing, and a flaw it did not have is. Answer `unknown` when you cannot tell, and know the ' +
    'round reads `unknown` as `introduced`.';

/** H1/R1 — the contract that keeps a refinement a revision (the loop's endless-rewrite fix). */
const REVISION_CONTRACT =
    '- Change only what the FIX TASKS require, and only the coordinated minimum: the passages whose facts, ' +
    'causal links, timeline or consequences the fix actually touches.\n' +
    '- Keep the base draft’s other commitments, fields and sentences as they are. A rewrite from scratch ' +
    'discards what the previous round already settled and starts the loop again — that is the round this ' +
    'pipeline exists to save.\n' +
    '- A fix is answered by the draft’s CONTENT. Restating the same commitment in other words answers none of ' +
    'the tasks and will be marked `unresolved`.\n' +
    // HILL CLIMB — the mirror of the source's new line: the round is graded on what it KEEPS as much as on
    // what it changes, because the screening Critics now compare the candidate with the accepted draft and
    // one NEW critical/high rejects it however much else it fixed (`sample-select.ts:scoreSample`).
    '- Breaking something the base draft got right is a NEW defect: the critics compare your draft with ' +
    'the base, and one new critical or high rejects the draft however much else it fixed.\n' +
    '- Nothing here is judged on style: wording and sentence shape are settled in phase ③, when the chapters ' +
    'are written.';

describe('phase1-prompt — the Writer sampler (§5)', () => {
    it('round 1 is the Seed Brief plus the critical/high Knowledge, and nothing else', () => {
        const { store, story } = seedPhase1Store();
        const compiled = compileSamplePrompt(store, story.id, { round: 1 });

        // The system turn is the template's role prompt plus the output contract; the schema NAME
        // is what tells a downgraded provider what a valid answer looks like (§4.2).
        expect(compiled.system).toBe(
            'You are the Writer for phase ① in sampling mode. Answer with ONE JSON object.\n\n' +
                'Answer with ONE JSON object matching the `SummarySample` schema. You have no tools and exactly one turn. No prose outside the JSON.'
        );
        expect(compiled.user).toBe(`${SEED_BRIEF_BLOCK}\n\n${KNOWLEDGE_BLOCK}`);

        // Round 1 is the first draft: it must not carry a base revision or fix tasks (there is no
        // previous round to improve, and the round-2 headings would tell the model there is).
        expect(compiled.user).not.toContain('## BASE REVISION');
        expect(compiled.user).not.toContain('## FIX TASKS');

        // `normal`/`low` never enter the prefix — the deep-review Critic reads them via the tool.
        expect(compiled.user).not.toContain('K-ccc');
        expect(compiled.user).not.toContain('A shilling was twelve pence.');
    });

    it('is byte-identical across compiles and its hash is the pinned 16-char sha256 prefix', () => {
        const { store, story } = seedPhase1Store();
        const first = compileSamplePrompt(store, story.id, { round: 2 });
        const second = compileSamplePrompt(store, story.id, { round: 2 });

        expect(second.system).toBe(first.system);
        expect(second.user).toBe(first.user);
        expect(second.hash).toBe(first.hash);
        expect(first.hash).toBe(hashPhase1Prompt(first.system, first.user));
        expect(first.hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('carries no clock, run id or revision id — the prompt is a function of stored text only', () => {
        const { store, story, base, target } = seedPhase1Store();
        const compiled = compileSamplePrompt(store, story.id, { round: 2 });

        // A timestamp would change every compile and destroy the cache prefix; a run/revision id
        // would make the same draft hash differently in two rounds (§5's determinism rule).
        expect(compiled.system).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect(compiled.user).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect(compiled.user).not.toContain('run_2');
        expect(compiled.user).not.toContain('run_3');
        expect(compiled.user).not.toContain(base.id);
        expect(compiled.user).not.toContain(target.id);
    });

    it('round 2 adds the previous round selected draft and every open fix task, in priority order', () => {
        const { store, story, base } = seedPhase1Store();
        const compiled = compileSamplePrompt(store, story.id, { round: 2 });

        // The base revision is the SELECTED row of round 1, rendered from `body.fields` — which is
        // what "revise it, do not abandon it" needs (§6.8). `base.id` is deliberately absent.
        expect(compiled.user).toContain(
            '## BASE REVISION (the selected draft of the previous round — revise it, do not rewrite it)\n' +
                BASE_DRAFT_BLOCK
        );

        // H1/R1: the contract sits next to the draft it constrains. Rewriting the Summary from
        // scratch is what let a round "fix" a defect by forgetting it.
        expect(compiled.user).toContain(
            `## REVISION CONTRACT (what this round changes, and what it keeps)\n${REVISION_CONTRACT}`
        );

        // Priority DESC (`task_1` at 30 before `task_2` at 10), the closed task excluded, and each
        // task rendered with the finding's defect and evidence and the criterion's definition of
        // done (H1/R1, G-2, D-15).
        expect(compiled.user).toContain(
            `## FIX TASKS (every one must be visible in the new draft, by content, and each is judged by its id)\n${FIX_TASK_BLOCK}`
        );
        expect(compiled.user).not.toContain('done one');
        expect(base.round).toBe(1);
    });

    it('renders the fix list the JOB carried rather than whatever is open now (H1/R1)', () => {
        const { store, story } = seedPhase1Store();
        // `WorkItem.fixRefs` is frozen when the queue builds the job, so every sample of a round and
        // every screening pass of that round read the SAME block even if the Editor confirms another
        // finding mid-round (`run/types.ts:WorkItem.fixRefs`).
        const compiled = compileSamplePrompt(store, story.id, { round: 2, fixRefs: ['task_1'] });

        expect(compiled.user).toContain(
            '## FIX TASKS (every one must be visible in the new draft, by content, and each is judged by its id)\n' +
                '[task_1 · priority 10] name the river\n' +
                '  done looks like: Run verifyIdea (re-read the source, record evidence) before the lock, or keep the unverified Idea out of the artifact (D-27).'
        );
        expect(compiled.user).not.toContain('pay the promise');

        // A ref that no longer resolves drops out, and an empty list says so in the section rather
        // than leaving the model to guess whether the round carries work.
        const spent = compileSamplePrompt(store, story.id, { round: 2, fixRefs: [] });

        expect(spent.user).toContain(
            '## FIX TASKS (every one must be visible in the new draft, by content, and each is judged by its id)\n(none open)'
        );
        // The empty list also means "nothing was asked", so a re-read of the base draft is enough.
        expect(spent.user).toContain('## REVISION CONTRACT');
    });

    it('falls back to the raw Seed with P5’s note when no accepted brief exists', () => {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary', idea: 'The raw Seed is the only truth here.' });

        seedTemplate(store, {
            name: 'writer-summary-sampler',
            roles: [{ name: 'writer', kind: 'writer', prompt: 'You sample.' }],
            serves_phase: ['summary']
        });

        const compiled = compileSamplePrompt(store, story.id, { round: 1 });

        expect(compiled.user).toBe(
            '## SEED\nThe raw Seed is the only truth here.\n(no structured brief yet — the Seed itself is law, P5)\n' +
                '(The Seed Brief commits what it STATES; it is not an outline of everything the book must contain. Where it is silent, or a question is listed in `open_questions`, the Writer may supply any specific that stays compatible with it — an added place, consequence, stake or custom the Seed never named. That freedom is the job, not a defect: no pass may ask the Summary for foreshadowing, stakes or exhaustive detail that neither the Seed nor the Summary itself promised. A claim that CONTRADICTS the brief, or a commitment it states explicitly that the draft does not carry, is still the failure this level is graded on.)'
        );
        expect(compiled.user).not.toContain('## KNOWLEDGE');
    });

    it('states the missing role prompt instead of inventing instructions (D-17a)', () => {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary' });
        const compiled = compileSamplePrompt(store, story.id, { round: 1 });

        expect(compiled.system).toBe(
            '(no role prompt from "writer-summary-sampler" was found in the catalogue, so this run is instructed by its output contract alone — treat the absence as a template defect to report, D-17a)\n\n' +
                'Answer with ONE JSON object matching the `SummarySample` schema. You have no tools and exactly one turn. No prose outside the JSON.'
        );
    });
});

describe('phase1-prompt — a fix task says whether it repairs or proposes (T5)', () => {
    /**
     * One fix task over three findings that differ ONLY in the claim type: a marked `proposal`, a
     * row from before the field existed (no `kind` at all), and a row explicitly marked `issue`. The
     * header line prints the TASK's `finding_ref` (`finding_0`) in all three cases, so the compiled
     * blocks can differ by one thing only — the `kind:` line — which is what makes these exact pins.
     */
    function seedKindPair() {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary', idea: 'A cartographer returns to a mapped valley.' });

        const proposal = seedFinding(store, story.id, {
            target_ref: 'summary_1',
            criterion_ref: 'C-14',
            title: 'let the keeper lie first',
            detail: 'opening on the lie gives chapter 2 its tension',
            evidence: 'sec_1: "he told them the truth"',
            cost: 'major',
            kind: 'proposal',
            state: 'approved'
        });

        const task = seedTask(store, story.id, {
            kind: 'fix',
            title: 'open on the lie',
            detail: 'move the lie into the first paragraph',
            priority: 30,
            criterion_ref: 'C-14',
            finding_ref: proposal.id
        });

        // The same fix task over the two defect readings. `legacy` stands for a row raised before
        // `kind` shipped; `marked` for one raised with the default named.
        const legacy = seedFinding(store, story.id, {
            target_ref: 'summary_1',
            criterion_ref: 'C-14',
            title: 'let the keeper lie first',
            detail: 'opening on the lie gives chapter 2 its tension',
            evidence: 'sec_1: "he told them the truth"',
            cost: 'major',
            state: 'approved'
        });
        const marked = seedFinding(store, story.id, {
            target_ref: 'summary_1',
            criterion_ref: 'C-14',
            title: 'let the keeper lie first',
            detail: 'opening on the lie gives chapter 2 its tension',
            evidence: 'sec_1: "he told them the truth"',
            cost: 'major',
            kind: 'issue',
            state: 'approved'
        });

        return { task, proposal, legacy, marked };
    }

    it('prints the kind line on a proposal, between the work and the defect (T5)', () => {
        const { task, proposal } = seedKindPair();

        // The line sits AFTER `work:` and BEFORE `defect:` because the block's order is fixed (§5's
        // cache rule), and it has to be in front of the defect wording: that wording was copied from
        // the Critic's complaint, and a sample that reads "nothing pays the promise" re-drafts the
        // paragraph instead of writing the better one that was proposed.
        //
        // D-33b renamed the KIND TOKEN only. The parenthetical stays plain English — "an improvement,
        // not a defect" is the definition the Writer needs (`shared/types.ts` documents a proposal as
        // an improvement the Seed never had to promise), whereas restating the token would teach the
        // word without teaching the difference.
        expect(renderFixTask(task, proposal)).toBe(
            '[task_0 · priority 30 · finding_0] open on the lie\n' +
                '  work: move the lie into the first paragraph\n' +
                '  kind: proposal (an improvement, not a defect)\n' +
                '  defect: opening on the lie gives chapter 2 its tension\n' +
                '  evidence: sec_1: "he told them the truth"\n' +
                '  criterion: C-14'
        );
    });

    it('renders a defect byte-for-byte as it did before the field, marker only on a proposal (T5)', () => {
        const { task, legacy, marked } = seedKindPair();
        // The header line prints the TASK's `finding_ref` (`finding_0`, the proposal this task was
        // opened for), not the finding passed in — which is exactly why these two pins are the honest
        // marker-only check: the only thing that may differ between a proposal card and a defect card
        // is the `kind:` line.
        const defectBlock =
            '[task_0 · priority 30 · finding_0] open on the lie\n' +
            '  work: move the lie into the first paragraph\n' +
            '  defect: opening on the lie gives chapter 2 its tension\n' +
            '  evidence: sec_1: "he told them the truth"\n' +
            '  criterion: C-14';

        // A row that predates `kind` compiles EXACTLY as it did pre-T5 — no marker, no blank, no
        // re-labelled line. That is the back-compat half: a re-compile of a stored prompt over legacy
        // rows must keep its `prompt_hash`.
        expect(renderFixTask(task, legacy)).toBe(defectBlock);
        // The explicit default reads the same as the absent one, which is what makes `kind: 'issue'`
        // a no-op rather than a second rendering path.
        const explicitIssue = renderFixTask(task, marked);

        expect(explicitIssue).toBe(defectBlock);
        expect(explicitIssue).toBe(renderFixTask(task, legacy));
        // Marker-only rendering: nothing about the kind is printed unless the row IS a proposal.
        expect(renderFixTask(task, legacy)).not.toContain('kind');
        expect(explicitIssue).not.toContain('kind');
    });
});

describe('phase1-prompt — the screening Critic (§6.4 step 4)', () => {
    it('carries the target draft’s fields and the critical/high-only screening contract', () => {
        const { store, story, base, target } = seedPhase1Store();
        // H2/R2 moved the verification sections onto the COMPARISON rather than the fix list, so the
        // round-1 negative needs a round-1 CANDIDATE: `target` is a round-2 draft and the book already
        // holds a selected round-1 Summary, so screening it — even with an empty fix list — now shows
        // the accepted draft (the case below pins exactly that). A first-round draft is the one state
        // with nothing to be inherited FROM (R5), so it is what this assertion must read.
        const firstDraft = store.revisions.create(
            {
                story_id: story.id,
                unit_kind: 'summary',
                unit_ref: 'summary_1',
                // The same fields as `target`, so the TARGET DRAFT body below stays byte-identical and
                // only the round — the thing that decides the verification sections — differs.
                body: target.body,
                run_ref: 'run_3',
                state: 'drafted',
                verdict_refs: [],
                round: 1
            },
            AUTHOR_ATTR
        );
        const compiled = compileScreenPrompt(store, story.id, firstDraft.id, { fixRefs: [] });

        expect(compiled.system).toBe(
            'You are the screening Critic for phase ①. Report ONLY critical and high problems.\n\n' +
                'Answer with ONE JSON object matching the `IssueList` schema. You have no tools and exactly one turn. No prose outside the JSON.'
        );

        expect(compiled.user).toBe(
            `${SEED_BRIEF_BLOCK}\n\n${KNOWLEDGE_BLOCK}\n\n` +
                '## TARGET DRAFT\n' +
                'premise: Maren returns.\n' +
                'promise: She floods it.\n' +
                'theme: Loss.\n' +
                'tone: Cold.\n' +
                'ending: Water.\n' +
                'world_rules: Engineering.\n\n' +
                SCREEN_CONTRACT
        );

        // A round-1 screen is not a verification: no base draft, no fix list, no certificate asked,
        // and no sibling sample or revision id (D-21 keeps the other drafts out of a Critic's view).
        expect(compiled.user).not.toContain('## BASE REVISION');
        expect(compiled.user).not.toContain('## SELECTED DRAFT');
        expect(compiled.user).not.toContain(ISSUE_ORIGIN_INSTRUCTION);
        expect(compiled.user).not.toContain('## FIX TASKS');
        expect(compiled.user).not.toContain('fix_verifications');
        // No comparison, so no origin rule either: a round-1 screen has no accepted draft to call a
        // defect inherited FROM, and asking it would invite the model to invent a pedigree (§6.5, R5).
        expect(compiled.user).not.toContain('Every issue you report also names its');
        expect(compiled.user).not.toContain(firstDraft.id);
        expect(compiled.user).not.toContain(target.id);
        expect(compiled.user).not.toContain(base.id);
    });

    it('H2/R2 — an accepted base with an EMPTY queued fix list still carries the accepted draft and the origin rule', () => {
        const { store, story, target } = seedPhase1Store();
        // THE SEAM V1 FOUND: the queue can read empty between arming and running (the Editor discards
        // the rows, or the only fix was a prerequisite that another role settled). The gate still
        // measures this candidate against the accepted Summary — `records.ts:roundSampleScores` hands
        // `scoreSample` the base whatever the fix list says, and an unclassified critical counts as
        // introduced (fail closed) — so a Critic that was never shown the accepted draft would be
        // judging a comparison it cannot see. SELECTED DRAFT and the origin rule ride on the
        // COMPARISON; the fix certificate stays with the fix list.
        const compiled = compileScreenPrompt(store, story.id, target.id, { fixRefs: [] });

        expect(compiled.user).toBe(
            `${SEED_BRIEF_BLOCK}\n\n${KNOWLEDGE_BLOCK}\n\n` +
                `## SELECTED DRAFT (the text the target draft below replaces — judge whether it was actually revised)\n${BASE_DRAFT_BLOCK}\n\n` +
                '## TARGET DRAFT\n' +
                'premise: Maren returns.\n' +
                'promise: She floods it.\n' +
                'theme: Loss.\n' +
                'tone: Cold.\n' +
                'ending: Water.\n' +
                'world_rules: Engineering.\n\n' +
                `${SCREEN_CONTRACT}\n\n${ISSUE_ORIGIN_INSTRUCTION}`
        );

        // Nothing was asked of this draft, so no verdict is demanded by id — but the comparison, and
        // therefore the origin question, is still on the page.
        expect(compiled.user).not.toContain('## FIX TASKS');
        expect(compiled.user).not.toContain(FIX_VERIFY_CONTRACT);
        expect(compiled.user).not.toContain('fix_verifications');
        expect(compiled.user).toContain(BASE_DRAFT_BLOCK);
    });

    it('H1/R2 — a refinement screen is given the draft it replaces and certifies every fix by id', () => {
        const { store, story, target } = seedPhase1Store();
        const compiled = compileScreenPrompt(store, story.id, target.id, { fixRefs: ['task_0', 'task_1'] });

        // The verification sections sit BEFORE the target draft on purpose: every sample of the round
        // shares those bytes, so the screening batch reads one cache prefix and only the candidate
        // differs (§5's argument applies to screens too).
        expect(compiled.user).toBe(
            `${SEED_BRIEF_BLOCK}\n\n${KNOWLEDGE_BLOCK}\n\n` +
                `## SELECTED DRAFT (the text the target draft below replaces — judge whether it was actually revised)\n${BASE_DRAFT_BLOCK}\n\n` +
                `## FIX TASKS (verify every one against the target draft, by its id)\n${FIX_TASK_BLOCK}\n\n` +
                '## TARGET DRAFT\n' +
                'premise: Maren returns.\n' +
                'promise: She floods it.\n' +
                'theme: Loss.\n' +
                'tone: Cold.\n' +
                'ending: Water.\n' +
                'world_rules: Engineering.\n\n' +
                // The origin rule rides the certificate, in the SAME section, because it is the same
                // comparison the pass is already holding: accepted draft above, candidate below.
                `${SCREEN_CONTRACT}\n\n${FIX_VERIFY_CONTRACT}\n\n${ISSUE_ORIGIN_INSTRUCTION}`
        );

        // The rule is asked in the order the Critic needs it: fix verdicts first (they decide the
        // certificate), then the origin of each issue it reports.
        expect(compiled.user.indexOf(FIX_VERIFY_CONTRACT)).toBeLessThan(compiled.user.indexOf(ISSUE_ORIGIN_INSTRUCTION));
        expect(compiled.user.indexOf(ISSUE_ORIGIN_INSTRUCTION)).toBeLessThan(compiled.user.length);

        // This is the same one-turn pass that ranks the round: no second pipeline, no second Critic
        // with a different brief to disagree with (`loop/sample-select.ts:scoreSample`).
        expect(compiled.user).not.toContain('## BASE REVISION');
        expect(compiled.user).not.toContain(target.id);
    });

    it('states a missing target draft without naming the id it could not find', () => {
        const { store, story } = seedPhase1Store();
        const compiled = compileScreenPrompt(store, story.id, 'revision_999');

        expect(compiled.user).toContain(
            '## TARGET DRAFT\n(no target draft was found for this screen — a screening run with no draft can judge nothing; answer with {"issues":[]})'
        );
        // Naming an id would make the prompt depend on the caller's value, not on the book.
        expect(compiled.user).not.toContain('revision_999');
    });
});

// ---------------------------------------------------------------------------
// T3 — the Seed-silence rule on the tool-less paths
// ---------------------------------------------------------------------------

/**
 * The clause every layer must carry, quoted here once so a screen and a deep review cannot drift apart:
 * the Seed/Seed Brief is a set of commitments, not an outline, and the Writer may invent compatible
 * specifics. Written as the Author's two screenshot findings name them — an unplanted ending detail and
 * a stake the Seed left open — because those are the sentences a model has to recognise its own bad
 * finding in.
 */
const SEED_SILENCE_RULE = [
    'The Seed is general and is not an outline',
    'the Writer may invent any specific that does not contradict it',
    'stakes or consequences the Seed never stated',
    'setup the Summary did',
    'quote only an absence'
];

describe('phase1-prompt — T3: the Seed-silence rule reaches every model-facing surface', () => {
    it('is carried by the engine, not the template: an Author-written screening prompt cannot drop it', () => {
        // §8 makes the role prompts Author-editable copies, and `compileScreenPrompt` puts the template in
        // the SYSTEM turn and the contract in the USER turn. A custom prompt that says nothing about the
        // Seed must therefore still produce a screen that knows an absence is not an issue — otherwise the
        // doctrine would live only in the built-in template and vanish on the first edit (R1/R3).
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary', idea: 'A bird searches for what the fire took.' });

        seedTemplate(store, {
            name: 'critic-screening',
            serves_phase: ['summary'],
            roles: [{ name: 'critic', kind: 'critic', prompt: 'You read this Author\u2019s shelf. Report what is wrong.' }]
        });

        store.seedBriefs.create(
            {
                story_id: story.id,
                seed_hash: 'ffff0000',
                logline: 'A bird searches for what the fire took.',
                protagonist: 'the bird',
                want: 'to find the seed',
                // The Seed says nothing about what is lost — the Author's screenshot case, recorded as the
                // open question it is rather than as an invented stake.
                obstacle: 'the burned ridge',
                stakes: '',
                setting: 'a burned ridge',
                world_rules: [],
                promise: 'the search ends somewhere',
                constraints: [],
                open_questions: ['what does the bird lose if the search fails?'],
                status: 'accepted'
            },
            AUTHOR_ATTR
        );

        const draft = store.revisions.create(
            {
                story_id: story.id,
                unit_kind: 'summary',
                unit_ref: 'summary_0',
                body: { fields: { premise: 'A bird crosses the ridge.', ending: 'It plants what it finds.' } },
                run_ref: 'run_1',
                state: 'drafted',
                verdict_refs: [],
                round: 1
            },
            AUTHOR_ATTR
        );

        const compiled = compileScreenPrompt(store, story.id, draft.id);

        // The custom prompt is still the system turn (the rule is not hiding there), and every clause of
        // the doctrine is in the user turn the model actually answers.
        expect(compiled.system).toBe(
            'You read this Author’s shelf. Report what is wrong.\n\n' +
                'Answer with ONE JSON object matching the `IssueList` schema. You have no tools and exactly one turn. No prose outside the JSON.'
        );

        for (const clause of SEED_SILENCE_RULE) {
            expect(compiled.user).toContain(clause);
        }

        // The gates this change must NOT relax: the two severities, the verbatim quote, the criterion
        // names, and the empty answer as a legitimate reply. The quote/location/detail/criterion sentence is
        // pinned WHOLE — `detail` is the schema-required field the clause now names
        // (`shared/schemas/group-review.ts:102,127`), and this test is the one place the doctrine is checked
        // against an Author's CUSTOM role prompt, so a mirror that drops the clause on a custom template has
        // to fail here rather than silently cost the book an answer with no stated defect.
        expect(compiled.user).toContain('a critical contradicts the Seed Brief or a critical Knowledge entry');
        expect(compiled.user).toContain('A high leaves unpaid a commitment the Seed Brief states EXPLICITLY');
        expect(compiled.user).toContain(
            'Quote the offending field verbatim in `quote`, name the field in `location`, say in `detail` what is wrong and where, and cite `C-14`, `C-15` or `seed` in `criterion`.'
        );
        expect(compiled.user).toContain('Return {"issues":[]} when the draft holds');
    });

    it('renders a silent Seed field as an open choice, never as a blank that reads like an unpaid promise', () => {
        const { store, story } = seedPhase1Store();

        // Overwrite the fixture's stated stakes with a brief whose Seed left them open — the shape the
        // structuring Editor is told to produce (`open_questions` carries the gap, the required field is
        // empty). A bare `stakes: ` line is what a Critic read as "the Summary never says what is lost".
        const brief = store.seedBriefs
            .list()
            .find((candidate) => candidate.story_id === story.id && candidate.status === 'accepted');

        expect(brief?.stakes).toBe('her memory');

        store.seedBriefs.update(brief?.id ?? '', { stakes: '' }, {
            ...AUTHOR_ATTR,
            why: 'the Seed states no stake, so the brief records it open'
        });

        const marker =
            'stakes: (the Seed states nothing here — it is open, and the Writer may supply any detail that stays compatible with the Seed)';

        const sample = compileSamplePrompt(store, story.id, { round: 1 });
        const screen = compileScreenPrompt(store, story.id, 'revision_999');

        // Named open in BOTH prompts, since both put the brief in front of a model (R1).
        expect(sample.user).toContain(marker);
        expect(screen.user).toContain(marker);
        // The bare blank that used to sit there — and read as an unpaid promise — is gone, and the
        // stated stakes of the other fixture are not invented away either.
        expect(sample.user).not.toContain('stakes: \n');
        expect(screen.user).not.toContain('stakes: \n');
        expect(sample.user).not.toContain('stakes: her memory');
        // Everything else in the block is untouched: the open question that carries the gap is still shown.
        expect(sample.user).toContain('open_questions:\n- who flooded the valley?');
    });
});

// ---------------------------------------------------------------------------
// SUMMARY PHRASE — the two GROUP prompts (R2, R3, R5, R7)
// ---------------------------------------------------------------------------
//
// WHY THIS SECTION IS ITS OWN FIXTURE: the sampler fixture above is a `summary_mode: sampling` book with
// a Revision row to render, and the group compilers read `phrase_groups` rows instead. The shared blocks
// (`SEED_BRIEF_BLOCK`, `KNOWLEDGE_BLOCK`) still apply, because the two pipelines read the same Seed and
// the same Knowledge — which is itself the point: switching a book to groups changes the ARTIFACT the
// prompt renders, nothing else in the prefix.
//
// WHAT IS PINNED, and why each one is a rule rather than a detail:
//   1. the group ids are PRINTED, in catalog order, in every heading — the answer contract carries
//      `group_ref`, and a model can only copy what it can see (R2/R3). A prompt that named groups only by
//      key would make every batch answer with a key the engine then has to guess an id for;
//   2. ONLY the groups the job named are offered to the Writer, while the Critic is shown the WHOLE
//      Overview — a fix that rewrote a group nobody asked for would move four groups' neighbours under a
//      review that judged one (R2), and an issue about a group the Critic never saw cannot be attributed;
//   3. the FIX TASKS section follows the JOB's refs, and vanishes when the batch has none — in the review
//      its verification contract vanishes with it, because a Critic asked to certify fixes that were
//      never asked for invents them (H1/R2);
//   4. both prompts stay a pure function of stored text (no clock, no run id, no revision id), which is
//      what makes the hash an audit key and the provider's prefix cache work (R7);
//   5. nothing about world rules reaches either prompt: §4.2's `summaries.world_rules` is a DEPRECATED
//      field with no group (R1), so a sixth heading in a group prompt would put a field no Writer owns in
//      front of a model that is being asked to answer for five.

/** The installed Overview this fixture writes, one text per group — short, distinct, and quoted verbatim. */
const GROUP_TEXTS: Record<string, string> = {
    premise: 'A return to a mapped valley that no longer matches the map.',
    promise: 'The map and the territory reconcile, at the price of the map.',
    theme: 'Memory against measurement.',
    tone: 'Plain, cold, third person limited.',
    ending: 'She floods the valley and keeps the map.'
};

/**
 * A group-managed phase ① book: the same Seed Brief and Knowledge as the sampler fixture, five catalog
 * groups with PINNED ids (`recordUidAt(1)` is the Phrase row, `recordUidAt(2)`…`(6)` are the five groups
 * in catalog order), all five installed to number 1 through the real install, one approved group-scoped
 * finding with its open fix task, a second open task with no finding, and the legacy `world_rules` field
 * set to a sentence that must never appear in a group prompt.
 */
function seedGroupStore() {
    const store = Store.empty();
    const seeded = seedStory(store, { phase: 'summary' });
    const story = store.stories.update(
        seeded.id,
        { summary_mode: 'groups' },
        { ...AUTHOR_ATTR, why: 'seed: a group-managed Summary (R1)' },
        [{ id: seeded.id, rev: seeded.rev }]
    );

    seedTemplate(store, {
        name: 'writer-summary-sampler',
        roles: [
            {
                name: 'writer',
                kind: 'writer',
                prompt: 'You are the Writer for phase ① in sampling mode. Answer with ONE JSON object.'
            }
        ],
        serves_phase: ['summary']
    });
    seedTemplate(store, {
        name: 'critic-screening',
        roles: [
            {
                name: 'critic',
                kind: 'critic',
                prompt: 'You are the screening Critic for phase ①. Report ONLY critical and high problems.'
            }
        ],
        serves_phase: ['summary']
    });

    store.seedBriefs.create(
        {
            story_id: story.id,
            seed_hash: 'abcd1234',
            logline: 'A cartographer finds her map is wrong.',
            protagonist: 'Maren',
            want: 'to prove the map',
            need: 'to accept the water',
            obstacle: 'the reservoir',
            stakes: 'her memory',
            setting: 'a drowned valley, 1963',
            world_rules: ['no magic', 'the reservoir is engineering'],
            promise: 'map and territory reconcile',
            tone_hints: 'cold, precise',
            constraints: ['no flashbacks'],
            open_questions: ['who flooded the valley?'],
            status: 'accepted'
        },
        AUTHOR_ATTR
    );

    store.knowledge.create(
        {
            story_id: story.id,
            kind: 'place',
            topic: 'harbour',
            claim: 'The harbour freezes in January.',
            importance: 'critical',
            sources: [
                { url_or_title: 'Atlas', claim: 'freezes', accessed_at: '1963-01-01' },
                { url_or_title: 'Almanac', claim: 'January', accessed_at: '1963-01-01' }
            ],
            fingerprint: 'K-aaa',
            seen_count: 1,
            author: 'researcher'
        },
        AUTHOR_ATTR
    );
    store.knowledge.create(
        {
            story_id: story.id,
            kind: 'period',
            topic: 'revolver',
            claim: '1880 revolvers hold six rounds.',
            detail: 'single action',
            importance: 'high',
            sources: [{ url_or_title: 'https://example.test/revolver', claim: 'six rounds', accessed_at: '1963-01-01' }],
            fingerprint: 'K-bbb',
            seen_count: 1,
            author: 'researcher'
        },
        AUTHOR_ATTR
    );

    let next = 1;
    const groups = ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!.groups;

    // The real install, so the prompt reads the state a dispatched batch leaves behind (group rows at
    // number 1, one `latest` revision per group, the Overview mirror written).
    const installed = installGroupRevisions(
        store,
        story,
        // The install CASes each group row, so it is handed FRESH rows (T-4: re-read, never force).
        groups.map((group) => ({ group: store.phraseGroups.require(group.id), content: GROUP_TEXTS[group.key] })),
        { ...AUTHOR_ATTR, why: 'seed: the first group batch installed (R2)' },
        { runRef: 'run_1', workItemRef: 'wi_draft_groups_summary_0_7fc4' }
    );

    const finding = seedFinding(store, story.id, {
        target_ref: 'summary_0',
        criterion_ref: 'C-14',
        title: 'the premise contradicts the Seed',
        detail: 'the Overview promises a cartographer; the Seed says the map was destroyed before she drew it',
        evidence: 'premise: "the cartographer returns" — the Seed states the map was destroyed in 1954',
        cost: 'critical',
        state: 'approved',
        fingerprint: 'C-14|summary_0'
    });

    // R3's attribution: the defect names the ONE group it is about, which is what routes the fix there.
    store.findings.update(
        finding.id,
        { group_refs: [groups[0].id] },
        { ...AUTHOR_ATTR, why: 'seed: the deep review scoped this defect to premise (R3)' },
        [{ id: finding.id, rev: finding.rev }]
    );

    seedTask(store, story.id, {
        kind: 'fix',
        title: 'pay the premise the Seed states',
        detail: 'the premise keeps a cartographer the Seed destroyed',
        priority: 30,
        criterion_ref: 'C-14',
        finding_ref: finding.id
    });
    seedTask(store, story.id, { kind: 'fix', title: 'name the river', priority: 10, criterion_ref: 'C-15' });

    const summary = store.summaries.require('summary_0');

    store.summaries.update(
        summary.id,
        { world_rules: 'LEGACY WORLD RULES FIELD — must never reach a group prompt' },
        { ...AUTHOR_ATTR, why: 'seed: the deprecated legacy field (R1)' },
        [{ id: summary.id, rev: summary.rev }]
    );

    // FRESH group rows, post-install: `groupEntry` below renders each row's `revision`, and the prompt
    // reads the installed state (number 1), not the catalog's unwritten one.
    return { store, story, groups: groups.map((group) => store.phraseGroups.require(group.id)), installed };
}

/** One group's rendered section — the catalog definition quoted, the GROUP's id printed, its text shown. */
const groupEntry = (group: PhraseGroup): string =>
    `### ${phraseGroupDefinition(group.key)?.title ?? group.title} (group_ref=${group.id}, key=${group.key}, revision=${group.revision})\n` +
    `${phraseGroupDefinition(group.key)?.description ?? group.description}\n` +
    `current text:\n${GROUP_TEXTS[group.key]}`;

/** The whole Overview block, in catalog order, exactly as the Critic is shown it. */
const overviewBlock = (groups: PhraseGroup[]): string => groups.map((group) => groupEntry(group)).join('\n\n');

/** The C-14 `fix_hint` the fix block prints as the work's definition of done (G-2). */
const C14_DONE =
    'Remove what contradicts the Seed, repair what contradicts the Summary’s own promise, and add only a ' +
    'commitment the Seed states explicitly that the Summary does not carry; what the Seed leaves open is the ' +
    "Writer’s to fill with any compatible detail, so its absence is not a defect to fix (P5: the Seed is " +
    'never edited to pass).';

/** The one fix task the job carries, rendered by the shared fix-task block the sampler tests pin. */
const GROUP_FIX_TASK_BLOCK =
    '[task_0 · priority 30 · finding_0] pay the premise the Seed states\n' +
    '  work: the premise keeps a cartographer the Seed destroyed\n' +
    '  defect: the Overview promises a cartographer; the Seed says the map was destroyed before she drew it\n' +
    '  evidence: premise: "the cartographer returns" — the Seed states the map was destroyed in 1954\n' +
    '  criterion: C-14\n' +
    `  done looks like: ${C14_DONE}`;

/** Both open tasks, priority DESC — what an UNSPECIFIED fix list compiles to (every open task). */
const ALL_FIX_TASK_BLOCK =
    `${GROUP_FIX_TASK_BLOCK}\n` +
    '[task_1 · priority 10] name the river\n' +
    '  done looks like: Run verifyIdea (re-read the source, record evidence) before the lock, or keep the unverified Idea out of the artifact (D-27).';

/** R7 — the group Writer's answer contract, mirrored from `phase1-prompt.ts:GROUP_DRAFT_INSTRUCTION`. */
const GROUP_DRAFT_INSTRUCTION =
    'Answer with one `groups` entry for EVERY group named above, and for NO other group: `group_ref` is exactly the id ' +
    'in that heading, and `content` is that group’s COMPLETE text — not a diff, not a note about it. A group this ' +
    'job did not name is not yours to rewrite, and a group it named that you leave out fails the whole batch: the ' +
    'engine installs an answer for all the named groups or for none, so a half answer buys nothing.\n' +
    '- Where the group already has a current text, REVISE it. Change what the FIX TASKS require and the coordinated ' +
    'minimum around it; keep every other commitment it makes, because the other four groups are being read against ' +
    'those facts right now.\n' +
    '- A fix task is answered by the group’s CONTENT. Restating the same commitment in other words answers none of ' +
    'the tasks.\n' +
    '- Breaking a fact another group depends on is a new defect: the reviewers read all five groups together.\n' +
    // T3 — mirrored from the source: a batch is malformed three ways (missing, extra, duplicated) and the
    // Writer also does not certify its own cure (`phrase/revisions.ts:parseGroupDraftAnswer`,
    // `phrase/findings.ts:findingGroupScope`).
    '- The same group twice, or a `group_ref` this job never printed, fails the batch exactly as a missing one does: nothing is installed, and every group keeps the text it had.\n' +
    '- Your own word that a defect is gone proves nothing: the next review decides, by quoting the installed group that shows the repair. Answer the whole defect in every group it names, or claim nothing — and every group a fix names is already in THIS batch, because the loop never sends half a defect: one pass answers it in all of them, or the defect survives in the group you left alone.\n' +
    // T6b — mirrored from the source: a LOCKED group is fixed text, and the bullet is in the PROMPT because
    // a batch that names one is refused WHOLE (`phrase/revisions.ts:installGroupRevisions`), so the Writer
    // would otherwise lose a pass for a repair that was never available to it.
    '- A group marked `LOCKED` — in the GROUPS block or in the LOCKED PEERS block above — is signed-off, FIXED text: never answer for one, never propose replacing a sentence of it, and treat the facts it states as facts your own groups must match. When a FIX TASK names a locked group, the repair belongs in the unlocked groups that can still move, because nothing can be rewritten there.\n' +
    '- Nothing here is judged on style: wording and sentence shape are settled in phase ③, when the chapters are ' +
    'written.';

/**
 * R3 — the group Critic's attribution rule, mirrored from `phase1-prompt.ts:GROUP_REVIEW_INSTRUCTION`.
 *
 * D-15/`group_quotes` adds the EVIDENCE half of the attribution rule, and it is mirrored here because it is
 * the half the engine later enforces (`phrase/revisions.ts:parseGroupReviewAnswer` refuses an issue whose
 * extra `group_refs` carry no quote). Two sentences carry it: the primary quote's group goes FIRST in
 * `group_refs`, and every other named group needs a `group_quotes` entry. Deleting either from the source
 * breaks the exact `toBe` below and the refusal pins in `phrase/revisions.test.ts` — the prompt and the
 * validator are one contract, and a prompt that promises a rule the validator does not run is a lie.
 */
const GROUP_REVIEW_INSTRUCTION =
    'EVERY issue you report names its `group_refs`: the group ids shown in the OVERVIEW section above. Name the one ' +
    'group the defect is in; name several, or all five, when the defect is in how they fit together — a promise the ' +
    'Ending does not keep, a Theme the Premise never grounds. Put the group your `quote` came from FIRST in `group_refs`, ' +
    'then every other group the defect crosses. An issue that cannot name a group is not an answer this ' +
    'pass may give: the loop routes work by group, and a defect with no group is work nobody can do.\n' +
    // T3 — mirrored from the source: one defect = one issue, the quote carries its address, a multi-group
    // fix certifies only when every named group carries it, and a review is a read (R3/R5).
    // D-33c COHERENCE (F4) — the last clause is mirrored too, because it is the half the reviewer flagged:
    // "report what you find without rationing" survives (the seat spends no rewrite allowance, so it must
    // not stay quiet to save effort) and is bound in the same sentence, so the licence cannot be read as a
    // licence to keep digging. The dedicated rule assertions are in the group-review describe below.
    'One defect that crosses several groups is ONE issue naming every group it crosses — never one issue per group, which would buy several rewrites of the same complaint. Say in `location` which group your `quote` came from and where in it the line sits: ids and headings are the address the Writer revises, prose summaries of the book are not. Put the primary quote in `quote`; for every OTHER group you name, add a `group_quotes` entry with that group’s `group_ref`, its `quote` and its `location` — a group named without a quote is refused, because naming it is a claim that you read it. When the prompt carries FIX TASKS, a task whose finding names several groups is `resolved` only once EVERY one of those groups carries the repair — one group fixed is not the finding fixed. And this pass writes nothing: it spends none of the Story’s rewrite allowance, so report what you find without rationing — and only what you found: nothing here asks you to go looking for a defect the Overview has not already surfaced.\n' +
    // T6b — mirrored from the source: a LOCKED section is still reviewable, but a complaint whose only
    // possible repair is a rewrite of fixed text is unworkable work (`findingActionableScope` routes the
    // claim to the groups that CAN move), so the reviewer is told to name the unlocked side.
    'A group the OVERVIEW marks `LOCKED` is signed-off, FIXED text: the loop cannot rewrite it, and the Author alone unlocks it. Judge the Overview with that section as the baseline — its facts are the facts the other four must keep — and put the change where change is possible: name in `group_refs` the UNLOCKED group or groups that have to move so the Overview agrees with the locked one. A defect whose only home is a locked sentence is not work this book can do, so report it as what it is (a cost already paid) rather than as a repair the Writer owes.';

/** The shared prefix both group prompts open with — identical to the sampling pipeline's. */
const SEED_AND_KNOWLEDGE = `${SEED_BRIEF_BLOCK}\n\n${KNOWLEDGE_BLOCK}`;

describe('phase1-prompt — the group Writer batch (R2, R5, R7)', () => {
    it('compiles the whole turn: the Seed, the Knowledge, the fixes, and ONLY the groups the job named', () => {
        const { store, story, groups } = seedGroupStore();

        // The batch names premise and tone, and names them OUT of catalog order — the compiler re-orders
        // them, because one state has to compile to one byte sequence (R7's cache argument).
        const compiled = compileGroupDraftPrompt(store, story.id, {
            groupRefs: [groups[3].id, groups[0].id],
            fixRefs: ['task_0']
        });

        // The system turn is the Writer template's role prompt plus the GROUP output contract: the schema
        // name is what a downgraded provider still answers to, and it is the group contract, not the
        // sampler's (`shared/schemas/group-draft.ts`).
        expect(compiled.system).toBe(
            'You are the Writer for phase ① in sampling mode. Answer with ONE JSON object.\n\n' +
                'Answer with ONE JSON object matching the `GroupDraft` schema. You have no tools and exactly one turn. No prose outside the JSON.'
        );
        expect(compiled.user).toBe(
            `${SEED_AND_KNOWLEDGE}\n\n` +
                '## FIX TASKS (every one must be visible in the rewritten groups, by content, and each is judged by its id)\n' +
                `${GROUP_FIX_TASK_BLOCK}\n\n` +
                '## GROUPS (the only groups this job may write — answer for every one of them)\n' +
                `${groupEntry(groups[0])}\n\n${groupEntry(groups[3])}\n\n${GROUP_DRAFT_INSTRUCTION}`
        );

        // The three groups outside the batch are not merely unhilighted — their ids do not appear at all,
        // so the model cannot answer for a group nobody asked it to write (R2's atomicity).
        expect(compiled.user).toContain(groups[0].id);
        expect(compiled.user).toContain(groups[3].id);
        expect([groups[1].id, groups[2].id, groups[4].id].map((id) => compiled.user.includes(id))).toEqual([
            false,
            false,
            false,
        ]);
    });

    it('prints each group id in its heading, because the answer carries the id and not the key (R2, R3)', () => {
        const { store, story, groups } = seedGroupStore();
        const compiled = compileGroupDraftPrompt(store, story.id, { groupRefs: [groups[0].id], fixRefs: [] });

        // Pinned as one literal heading line: `group_ref` is the field name in the answer contract, so the
        // prompt and the contract have to agree on the word, and the id has to be the row's.
        expect(compiled.user).toContain(
            `### Premise (group_ref=${groups[0].id}, key=premise, revision=1)\n` +
                'What the story is: the situation, who is in it, and the confrontation they are drawn into. ' +
                'One concrete account, no theme statement and no ending.\n' +
                `current text:\n${GROUP_TEXTS.premise}`
        );
        // The revision number rides the heading too: a fix that reads number 1 answers number 1, and the
        // Author's rail shows the same number for the same text.
        expect(compiled.user).toContain('revision=1');
    });

    it('carries the fix list the job named, and drops the section when the batch named none (H1/R1)', () => {
        const { store, story, groups } = seedGroupStore();
        const premise = groups[0].id;

        // Named: exactly that task, with its finding's defect and evidence (the Writer that only sees a
        // title rewrites the group instead of repairing the defect).
        const named = compileGroupDraftPrompt(store, story.id, { groupRefs: [premise], fixRefs: ['task_0'] });

        expect(named.user).toContain(GROUP_FIX_TASK_BLOCK);
        expect(named.user).not.toContain('name the river');

        // Unspecified: every open fix task, priority DESC — the same rule the sampling round follows, so a
        // sweep that forgets to copy its refs still cannot lose work.
        const open = compileGroupDraftPrompt(store, story.id, { groupRefs: [premise] });

        expect(open.user).toContain(ALL_FIX_TASK_BLOCK);

        // Empty: no heading at all. A `## FIX TASKS` section with nothing under it tells the model this is
        // a refinement round and invites it to change something nobody asked for.
        const none = compileGroupDraftPrompt(store, story.id, { groupRefs: [premise], fixRefs: [] });

        expect(none.user).not.toContain('## FIX TASKS');
        expect(none.user).not.toContain('task_0');
        expect(none.user).toBe(
            `${SEED_AND_KNOWLEDGE}\n\n## GROUPS (the only groups this job may write — answer for every one of them)\n${groupEntry(groups[0])}\n\n${GROUP_DRAFT_INSTRUCTION}`
        );
    });

    it('is byte-identical, hash-stable, and free of clocks and run ids (R7)', () => {
        const { store, story, groups } = seedGroupStore();
        const refs = { groupRefs: [groups[0].id, groups[1].id], fixRefs: ['task_0'] };
        const first = compileGroupDraftPrompt(store, story.id, refs);
        const second = compileGroupDraftPrompt(store, story.id, refs);

        expect(second.user).toBe(first.user);
        expect(second.hash).toBe(first.hash);
        expect(first.hash).toBe(hashPhase1Prompt(first.system, first.user));
        expect(first.hash).toMatch(/^[0-9a-f]{16}$/);

        // No clock, no run row, no revision id: the batch's prompt is a function of stored TEXT, so two
        // runs over the same book hit the same provider cache and the hash identifies the state (§5, R7).
        expect(first.system).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect(first.user).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect(first.user).not.toContain('run_1');
        expect(first.user).not.toContain('group_revision_0');
        expect(first.user).not.toContain('wi_draft_groups');
    });
});

describe('phase1-prompt — the group review pass (R3, R5)', () => {
    it('shows the Critic the WHOLE Overview — all five groups, ids, revision numbers and text', () => {
        const { store, story, groups } = seedGroupStore();
        const compiled = compileGroupReviewPrompt(store, story.id, {
            groupRefs: groups.map((group) => group.id),
            fixRefs: ['task_0']
        });

        expect(compiled.system).toBe(
            'You are the screening Critic for phase ①. Report ONLY critical and high problems.\n\n' +
                'Answer with ONE JSON object matching the `GroupReview` schema. You have no tools and exactly one turn. No prose outside the JSON.'
        );
        expect(compiled.user).toBe(
            `${SEED_AND_KNOWLEDGE}\n\n` +
                '## FIX TASKS (verify every one against the Overview below, by its id)\n' +
                `${GROUP_FIX_TASK_BLOCK}\n\n` +
                '## OVERVIEW — the five groups as they stand (every issue names the groups it is about)\n' +
                `${overviewBlock(groups)}\n\n${SCREEN_CONTRACT}\n\n${GROUP_REVIEW_INSTRUCTION}\n\n${FIX_VERIFY_CONTRACT}`
        );

        // The five ids, in catalog order — the attribution the answer has to quote (`group_refs`), and the
        // reason a multi-group defect can be closed at all (R3).
        const printed = [...compiled.user.matchAll(/group_ref=([0-9a-f-]+)/g)].map((match) => match[1]);

        expect(printed).toEqual(groups.map((group) => group.id));
    });

    it('renders the whole book when the seat names no group, and only the named ones when it does', () => {
        const { store, story, groups } = seedGroupStore();

        // An empty group set is the legacy "review the Overview" meaning, not "review nothing": every group
        // is shown, so the Critic still attributes its issues by group.
        const all = compileGroupReviewPrompt(store, story.id, { groupRefs: [], fixRefs: [] });

        expect(all.user).toContain(overviewBlock(groups));
        expect([...all.user.matchAll(/group_ref=/g)]).toHaveLength(5);

        // A seat aimed at two groups sees those two — and the prompt says which groups are IN SCOPE by
        // showing only them, rather than letting the Critic raise a defect it was never shown.
        const pair = compileGroupReviewPrompt(store, story.id, { groupRefs: [groups[1].id, groups[4].id], fixRefs: [] });

        expect(pair.user).toContain(overviewBlock([groups[1], groups[4]]));
        expect(pair.user).not.toContain(groups[0].id);
        expect([...pair.user.matchAll(/group_ref=/g)]).toHaveLength(2);
    });

    it('asks for fix verifications only when there are fixes to verify (H1/R2)', () => {
        const { store, story, groups } = seedGroupStore();
        const refs = groups.map((group) => group.id);

        const withFixes = compileGroupReviewPrompt(store, story.id, { groupRefs: refs, fixRefs: ['task_0'] });

        expect(withFixes.user).toContain(
            '## FIX TASKS (verify every one against the Overview below, by its id)\n' + GROUP_FIX_TASK_BLOCK
        );
        expect(withFixes.user).toContain(FIX_VERIFY_CONTRACT);

        // Without the fix list the certificate goes with it: a Critic asked for `fix_verifications` with no
        // FIX TASKS section above it answers by inventing a task to certify.
        const without = compileGroupReviewPrompt(store, story.id, { groupRefs: refs, fixRefs: [] });

        expect(without.user).not.toContain('## FIX TASKS');
        expect(without.user).not.toContain('fix_verifications');
        expect(without.user).toBe(
            `${SEED_AND_KNOWLEDGE}\n\n## OVERVIEW — the five groups as they stand (every issue names the groups it is about)\n${overviewBlock(groups)}\n\n${SCREEN_CONTRACT}\n\n${GROUP_REVIEW_INSTRUCTION}`
        );
    });

    it('states an unwritten group as unwritten, so a first review does not invent a defect about nothing', () => {
        const { store, story } = seedGroupStore();

        // Back to a book whose catalog exists but has never been written — the state a first draft is
        // dispatched into, and the state a review pass would otherwise read as five empty sections.
        for (const group of store.phraseGroups.list()) {
            const fresh = store.phraseGroups.require(group.id);

            store.phraseGroups.update(
                fresh.id,
                { content: '', revision: 0, updated_by: null },
                { ...AUTHOR_ATTR, why: 'seed: the groups are unwritten again' },
                [{ id: fresh.id, rev: fresh.rev }]
            );
        }

        const draft = compileGroupDraftPrompt(store, story.id, { groupRefs: [], fixRefs: [] });
        const review = compileGroupReviewPrompt(store, story.id, { groupRefs: [], fixRefs: [] });

        const marker = 'current text: (this group has never been written — write it from the Seed Brief)';

        expect(draft.user.match(/current text: \(this group has never been written/g)).toHaveLength(5);
        expect(review.user).toContain(marker);
        // The heading still prints the id: an unwritten group is still an address the answer quotes.
        expect(draft.user).toContain(
            `### Premise (group_ref=${recordUidAt(2)}, key=premise, revision=0)`
        );
    });

    it('binds the review pass’s "report without rationing" to what the Overview surfaced (D-33c)', () => {
        // WHY THIS TEST EXISTS: the seat that gets this block is a READ — it spends none of a group's rewrite
        // allowance (`loop/work.ts:groupWriteAttempts` counts WRITES only), which is the whole reason it is
        // told not to ration. The owner's rule cuts the other way as well: "a very hidden problem could take
        // ages to find", so a defect that has to be dug for is not worth a Writer round. The old copy stopped
        // at the licence, and one half of the prompt (this block, the USER turn) said only "keep reporting".
        // Both halves are pinned from the RENDERED turn, because the binding is what an edit can lose.
        const { store, story, groups } = seedGroupStore();
        const review = compileGroupReviewPrompt(store, story.id, {
            groupRefs: groups.map((group) => group.id),
            fixRefs: []
        });

        // (1) THE ANTI-SILENCE HALF SURVIVES — the seat is not told to hold an issue back to save effort.
        //     Deleting this is the failure D-33c was written against, so it is pinned on its own.
        expect(review.user).toContain(
            'And this pass writes nothing: it spends none of the Story’s rewrite allowance, so report what you find without rationing'
        );

        // (2) THE SAME SENTENCE IS BOUND — "only what you found", and the pass is told plainly that no part
        //     of the prompt is asking it to go looking for a break the text has not surfaced.
        expect(review.user).toContain(
            'so report what you find without rationing — and only what you found: nothing here asks you to go looking for a defect the Overview has not already surfaced.'
        );

        // (3) THE SHAPE THAT READ AS A LICENCE IS GONE. The old sentence ENDED at the licence ("…without
        //     rationing."), and a full stop there is what let it be read as "report exhaustively". Banning
        //     the terminator means the bound has to sit inside the sentence: rewording the clause past the
        //     pins above is fine, ending it there again is not.
        expect(review.user).not.toContain('without rationing.');

        // (4) SAID ONCE. The convergence pass (D-33c) removed near-duplicate copies of these rules because a
        //     rule stated three ways reads as a rule with three exceptions, so the licence appears exactly
        //     once in this seat's user turn — with its bound attached.
        expect(review.user.match(/without rationing/g)).toHaveLength(1);
    });

    it('names the quote every named group has to carry, and where the primary one goes (R3, D-15)', () => {
        // WHY THIS IS A PROMPT TEST AT ALL: the answer schema has ONE `quote` per issue, so a cross-group
        // complaint used to prove only ONE of the groups it named — "name three, quote one". The fix is a pair
        // of rules stated HERE and enforced there (`phrase/revisions.ts:parseGroupReviewAnswer`, pinned in
        // `phrase/revisions.test.ts`): the primary quote's group goes FIRST in `group_refs`, and every other
        // named group carries a `group_quotes` entry. A prompt that promised less than the validator enforces
        // costs the book a refused pass per attempt, so both halves are pinned from the RENDERED turn.
        const { store, story, groups } = seedGroupStore();
        const review = compileGroupReviewPrompt(store, story.id, {
            groupRefs: groups.map((group) => group.id),
            fixRefs: []
        });

        // (1) THE POSITION — the validator reads `group_refs[0]` as the quoted group, so the order is part of
        //     the contract and not a style preference.
        expect(review.user).toContain(
            'Put the group your `quote` came from FIRST in `group_refs`, then every other group the defect crosses.'
        );

        // (2) THE FIELD NAMES — an entry the engine cannot route is a refusal, so the sentence names the three
        //     fields exactly as `shared/schemas/group-review.ts:GroupReviewQuote` defines them.
        expect(review.user).toContain(
            'Put the primary quote in `quote`; for every OTHER group you name, add a `group_quotes` entry with ' +
                'that group’s `group_ref`, its `quote` and its `location` — a group named without a quote is refused, ' +
                'because naming it is a claim that you read it.'
        );

        // (3) THE REFUSAL IS PROMISED, not hinted: the seat that cannot quote a group has been told naming it
        //     is a claim of having read it, which is the sentence that makes the refusal non-arbitrary.
        expect(review.user).toContain('a group named without a quote is refused, because naming it is a claim that you read it.');

        // (4) SAID ONCE, AND NOTHING ELSE IN THE BLOCK MOVED: one mention of the array in this seat (no second
        //     copy elsewhere in the turn to drift from it), and the whole attribution block is the mirror.
        expect(review.user.match(/group_quotes/g)).toHaveLength(1);
        expect(review.user).toContain(GROUP_REVIEW_INSTRUCTION);
    });

    it('briefs the structured review with the screening template whatever slug the seat was scheduled with (D-17d)', () => {
        // WHY: a `review_groups` Work Item's `templateRef` is a POOL pick — which Critic angle runs the pass is
        // a scheduling fact, and D-17d's divergence settings live on that row. This seat is `toolMode: 'none'`,
        // so trusting the label handed it a deep reviewer's `raiseFinding`/`submitVerdict` copy: the model
        // answers a structured schema with tool vocabulary and the pass is refused. The whole system turn is
        // pinned identical, because the CONTRACT sentence rides the role prompt and a wrong slug would move it.
        const { store, story, groups } = seedGroupStore();

        seedTemplate(store, {
            name: 'critic-deep-review',
            roles: [
                {
                    name: 'critic',
                    kind: 'critic',
                    prompt: 'You are the deep Reviewer: read the ledger, file findings and submit a verdict.'
                }
            ],
            serves_phase: ['summary']
        });

        const refs = { groupRefs: groups.map((group) => group.id), fixRefs: ['task_0'] };
        const scheduled = compileGroupReviewPrompt(store, story.id, {
            ...refs,
            templateSlug: 'critic-deep-review'
        });
        const plain = compileGroupReviewPrompt(store, story.id, refs);

        expect(scheduled.system).toBe(
            'You are the screening Critic for phase ①. Report ONLY critical and high problems.\n\n' +
                'Answer with ONE JSON object matching the `GroupReview` schema. You have no tools and exactly one turn. No prose outside the JSON.'
        );
        expect(scheduled.system).toBe(plain.system);
        expect(scheduled.user).toBe(plain.user);
        expect(scheduled.hash).toBe(plain.hash);
        // The decoy is in the catalogue, so this is a leak detector and not a tautology: the tool-using copy is
        // nowhere on the wire, and the fallback sentence is absent because the screening row WAS found (D-17a).
        expect(store.templates.list().map((template) => template.name)).toContain('critic-deep-review');
        expect(scheduled.system).not.toContain('deep Reviewer');
        expect(`${scheduled.system}\n${scheduled.user}`).not.toContain('no role prompt from');
    });

    it('compiles identically twice, and carries no clock or run id (R7)', () => {
        const { store, story, groups } = seedGroupStore();
        const refs = { groupRefs: groups.map((group) => group.id), fixRefs: ['task_0'] };
        const first = compileGroupReviewPrompt(store, story.id, refs);
        const second = compileGroupReviewPrompt(store, story.id, refs);

        expect(second.user).toBe(first.user);
        expect(second.hash).toBe(first.hash);
        expect(first.hash).toBe(hashPhase1Prompt(first.system, first.user));
        expect(first.hash).toMatch(/^[0-9a-f]{16}$/);
        expect(first.user).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect(first.user).not.toContain('run_1');
        expect(first.user).not.toContain('sample_reviews');
    });
});

// ---------------------------------------------------------------------------
// D-65 / D-67 — the Reader's section score, compiled from the CLEAN SELECTION.
//
// THE ONE CLAIM THIS BLOCK PINS (§17.16): the bytes the Reader is shown are the bytes the score rows
// get recorded under, and they are the CLEAN SELECTION — never the group's newest text. The executor
// (`run/executor.ts:726-733`) hands the compiler the hash read back off the Work Item id and nothing
// else, so a compiler that quietly fell back to `PhraseGroup.content` would still produce a plausible
// prompt and would file a judgement under a book the Reader never saw. The hash-side of that property
// (the claim key ⇄ the persisted `vector_hash`) is pinned in `loop/section-scores.test.ts`; what lives
// here is the compiler itself.
//
// THE FIXTURE, in one sentence: five groups installed at number 1, a deep pass closing over that
// vector (so number 1 is Clean), then the SAME five groups installed again at number 2 with different
// prose nobody has reviewed. That is the smallest state in which "the selected text" and "the newest
// text" differ — and a state that doesn't differ cannot tell the two implementations apart.
// ---------------------------------------------------------------------------

/** The second batch: each group's newest text, with no verdict on any of it (D-67's superseded case). */
const LATER_TEXTS: Record<string, string> = {
    premise: 'A return to a mapped valley that the water redrew every winter.',
    promise: 'The map and the territory reconcile, at the price of the territory.',
    theme: 'Measurement against inheritance.',
    tone: 'Plain, warm, first person plural.',
    ending: 'She burns the map and keeps the valley.'
};

/**
 * The score seat's role prompt (`phase1-prompt.ts:SCORE_TEMPLATE_SLUG` = `reader-score`, role `reader`).
 * Any template with any sentence works — the point of seeding one is that the fallback sentence is NOT
 * what the seat sends when the catalogue does hold the score-only built-in. It is a STUB rather than the
 * built-in's own copy on purpose: the seat's contract is WHICH slug the compiler reads and the engine-owned
 * instruction block, and both are independent of the Author-editable voice (`templates.ts` pins the
 * built-in's text).
 */
const READER_ROLE_PROMPT = 'You are the Reader for the section score. Judge only the sections printed below.';

/**
 * The DECOY the score seat must never be briefed with: `reader-consistency` is the TOOL-CARRYING review
 * reader (verdict, findings, tasks, `readLedger`), and reading the seat's scheduling label as its voice was
 * the defect that told a `toolMode: 'none'` pass to file findings (P6). Its `kind` and its sentence are
 * distinctive so the pin below can name the leak it is guarding.
 */
const TOOL_READER_ROLE_PROMPT =
    'You are the deep Reader: read the ledger, file findings, open tasks and submit a verdict.';

/** §17.16's rule sentence above the sections, mirrored verbatim from `compileSectionScorePrompt`. */
const REVIEWED_SCORE_PREAMBLE =
    'These are the sections the crew stands behind: the newest CLEAN revision of each group. A section may ' +
    'not be the newest text its group has written — it is the newest one a cross-group review passed, and it ' +
    'is the only text you are being asked to grade.';

/**
 * D-65's answer contract, mirrored verbatim from `phase1-prompt.ts:SECTION_SCORE_INSTRUCTION` (the
 * same escape sequences, so the mirror is byte-identical rather than approximately so).
 */
const SECTION_SCORE_INSTRUCTION =
    'SCORE EVERY SECTION ONCE. For each group printed above, give a whole number from 0 to 100 that answers one question: ' +
    'how well does this section hold up as written \u2014 its OWN internal logic, its consistency with the OTHER four sections ' +
    '(the Ending the Premise earns, the Theme the Promise carries, the Tone the facts support), and the plausibility of what it ' +
    'asserts? Anchor the ends: 100 is a section nothing in the Overview contradicts, 70 is sound with a seam you can point at, ' +
    '40 is a section that fights its neighbours, 10 is a section that contradicts itself. Deduct for a contradiction you can ' +
    'name; do NOT deduct for detail the Seed never promised, for prose the chapters have not written yet, or for a change you ' +
    'would personally prefer \u2014 that is a taste, not a fault, and a number that moves on taste is a number nobody can read. ' +
    'Copy each section\u2019s `group_ref` from the heading above into `group_ref`, give ONE short `rationale` (the reason for the ' +
    // D-15 (cross-section evidence): the quoted line may come from the section the scored one CONTRADICTS, and
    // the rationale then names that other section. An absence cannot be quoted, so a cross-section fault whose
    // only proof sits in the neighbour has to be quotable somewhere or the Reader refuses to answer with a taste.
    'number, in a sentence) and ONE `evidence` quote taken verbatim from the section you scored, or \u2014 for a cross-section ' +
    'fault \u2014 from the section it contradicts; when the line is not from the scored section, name the section it came from in ' +
    '`rationale`. The schema carries one `evidence` string per section, so the quote is the one line the judgement rests on, ' +
    'not a bundle of lines from several sections. Name every group exactly ' +
    'once and no group twice. This pass REPORTS a number: it files no finding, opens no task, grades no fix, edits nothing, and ' +
    'answers nothing else.\n' +
    // T6b — mirrored from the source: a LOCKED section has no future tense, so a deduction for "I would have
    // written this differently" on text nothing may rewrite is a number the Author cannot act on.
    ' A section the heading marks `LOCKED` is signed-off, fixed text: score it exactly as written, and do not deduct for a change you would personally have made there, because no pass may make that change without the Author.';

/**
 * One group's REVIEWED section — `renderGroupEntry`'s reviewed branch: the SELECTED row's number in the
 * heading (not the group row's) and the SELECTED row's text under its own label.
 */
const reviewedEntry = (group: PhraseGroup, number: number, texts: Record<string, string>): string =>
    `### ${phraseGroupDefinition(group.key)?.title ?? group.title} (group_ref=${group.id}, key=${group.key}, revision=${number})\n` +
    `${phraseGroupDefinition(group.key)?.description ?? group.description}\n` +
    `reviewed text, standing behind this section:\n${texts[group.key]}`;

/** The whole reviewed block at one selection, catalog order — the sibling of `overviewBlock` above. */
const reviewedBlock = (groups: PhraseGroup[], number: number, texts: Record<string, string>): string =>
    groups.map((group) => reviewedEntry(group, number, texts)).join('\n\n');

/**
 * The hash a selection of five equal revision numbers claims under. The fixture keeps every group in
 * step, so a vector is `{each group id -> number}` and `groupVectorHash` is the same function the seat
 * and the settle both use — the expectation is derived, never copied out of a run.
 */
const selectionHashAt = (groups: PhraseGroup[], number: number): string =>
    groupVectorHash(Object.fromEntries(groups.map((group) => [group.id, number])) as Record<string, number>);

/** A batch installed through the real path (R2's numbering). Rows are re-read per call (T-4's CAS rule). */
function installBatch(store: Store, story: Story, texts: Record<string, string>, runRef: string) {
    return installGroupRevisions(
        store,
        story,
        store.phraseGroups
            .list()
            .filter((group) => group.story_id === story.id)
            // FRESH rows: an install CASes each group row, so a row captured before the previous install
            // would trip the store's own guard rather than test anything.
            .map((group) => ({ group: store.phraseGroups.require(group.id), content: texts[group.key] })),
        { ...AUTHOR_ATTR, why: `seed: the ${runRef} group batch installed (R2)` },
        { runRef, workItemRef: `wi_draft_groups_summary_0_${runRef}` }
    );
}

/**
 * A deep cross-group pass CLOSING over the current vector — the write `loop/engine.ts:settleJob` makes
 * in the same commit that closes a `wi_group_check_<vectorHash>_<pass>` run (D-67). The seat key names
 * the vector hash, so this stamps exactly the five rows that vector holds, or nothing if it moved.
 */
function stampCurrentVector(store: Store, story: Story, runRef: string) {
    return stampCleanRevisions(
        store,
        story,
        { seatKey: groupCheckSeatKey(groupVectorHash(groupRevisionVector(store, story.id)), 1), runRef },
        AUTHOR_ATTR
    );
}

/**
 * The state a `score_sections` seat is dispatched into (D-67): the five groups installed at number 1,
 * the fixture's premise-scoped finding CLOSED, and the TWO reader templates the two seats read —
 * `reader-score`, the score-only built-in this seat's system turn comes from
 * (`phase1-prompt.ts:SCORE_TEMPLATE_SLUG`), and the tool-carrying `reader-consistency` whose copy must
 * NEVER reach the score seat (the prompt would then ask a `toolMode: 'none'` pass to file findings and
 * open tasks, which is the wiring defect D-65 named). Closing the finding is not decoration — `approved`
 * is an OPEN state on D-33c's rule (`loop/records.ts:isOpenIssueFinding`), so while it stands nothing is
 * selectable for premise and the whole selection is incomplete.
 *
 * `stamped` comes back so the tests state their own precondition rather than assume one.
 */
function seedScoreStore() {
    const world = seedGroupStore();
    const { store, story } = world;

    const finding = store.findings.require('finding_0');

    store.findings.update(
        finding.id,
        { state: 'fixed' },
        { ...AUTHOR_ATTR, why: 'seed: the crew fixed the premise defect (D-33c)' },
        [{ id: finding.id, rev: finding.rev }]
    );

    seedTemplate(store, {
        name: 'reader-score',
        roles: [{ name: 'reader', kind: 'reader', prompt: READER_ROLE_PROMPT }],
        serves_phase: ['summary']
    });
    // The decoy: a seat that trusted its own `templateRef` (a scheduling label, D-17d's divergence rows
    // live there) would render THIS copy and hand a tool-using brief to a run that has no tools.
    seedTemplate(store, {
        name: 'reader-consistency',
        roles: [{ name: 'reader', kind: 'reader', prompt: TOOL_READER_ROLE_PROMPT }],
        serves_phase: ['summary']
    });

    return { ...world, stamped: stampCurrentVector(store, story, 'run_check_1') };
}

describe('phase1-prompt — the section score reads the clean selection (D-65, D-67)', () => {
    it('scores the CLEAN revision of every group and never shows the newer text the live rows hold', () => {
        const { store, story, groups, stamped } = seedScoreStore();

        // Precondition, stated: the deep pass certified number 1 of all five groups, in catalog order.
        expect(stamped.stamped.map((revision) => `${revision.group_key}:${revision.number}`)).toEqual([
            'premise:1',
            'promise:1',
            'theme:1',
            'tone:1',
            'ending:1'
        ]);

        // The book moves on; the selection does not. This is the only state that can tell "the text the
        // crew stands behind" apart from "the text the group row happens to carry".
        installBatch(store, story, LATER_TEXTS, 'run_2');

        expect(store.phraseGroups.require(groups[0].id)).toMatchObject({ revision: 2, content: LATER_TEXTS.premise });

        const selection = cleanSelectionOf(store, story);

        expect({ complete: selection.complete, vector_hash: selection.vector_hash }).toEqual({
            complete: true,
            vector_hash: selectionHashAt(groups, 1)
        });

        // The hash the seat claims under (`phrase/exclusion.ts:sectionScoreVectorHashOf` off the Work
        // Item id) is what the executor passes; the selection's own hash is the same value.
        const compiled = compileSectionScorePrompt(store, story.id, {
            groupRefs: groups.map((group) => group.id),
            vectorHash: selection.vector_hash
        });

        // The system turn is the reader template plus the SectionScores contract: no group id, no
        // revision number, no vector — so the cacheable prefix is shared across books (§5's rule).
        expect(compiled.system).toBe(
            `${READER_ROLE_PROMPT}\n\nAnswer with ONE JSON object matching the \`SectionScores\` schema. You have no tools and exactly one turn. No prose outside the JSON.`
        );

        // THE WHOLE USER TURN, exact: the Seed, the Knowledge, and the five SELECTED sections — no FIX
        // TASKS section (a score is of the text, not of the queue), and the engine's own contract.
        expect(compiled.user).toBe(
            `${SEED_AND_KNOWLEDGE}\n\n` +
                '## REVIEWED OVERVIEW — every section, scored (name each group_ref exactly once)\n' +
                `${REVIEWED_SCORE_PREAMBLE}\n\n${reviewedBlock(groups, 1, GROUP_TEXTS)}\n\n${SECTION_SCORE_INSTRUCTION}`
        );

        // THE DECISIVE HALF: not one of the five live texts is on the wire, and every heading prints the
        // SELECTED number. Were it the other way round, the score rows would be filed under vector
        // {…:1} while the Reader had graded {…:2} — §17.16's `shown == scored == recorded` lie.
        for (const text of Object.values(LATER_TEXTS)) expect(compiled.user).not.toContain(text);
        expect(compiled.user.match(/revision=\d/g)).toEqual([
            'revision=1',
            'revision=1',
            'revision=1',
            'revision=1',
            'revision=1'
        ]);

        // What a score pass must NOT carry, and the audit trail it must not leak: no fix list, no
        // run id of the pass that stamped the text, no clock (§5's byte-stability rule, unchanged).
        expect(compiled.user).not.toContain('## FIX TASKS');
        expect(compiled.user).not.toContain('run_check_1');
        expect(compiled.user).not.toContain('run_2');
        expect(compiled.user).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect(compiled.hash).toBe(hashPhase1Prompt(compiled.system, compiled.user));
    });

    it('is briefed by the score-only template, never by the tool-carrying reader its seat was scheduled with (D-65, P6)', () => {
        // THE WIRING D-65 KILLED: `reader-consistency` is the TOOL-CARRYING review reader — its copy tells the
        // model to file findings, open tasks and read the ledger — while the score seat is `toolMode: 'none'`
        // and may file NOTHING (P6). A seat's `templateRef` is a scheduling label (which row ran the pass), so
        // reading the prompt's VOICE from it briefed a no-tools Reader to file findings, and its answer was
        // refused by a schema with no field for them. `SCORE_TEMPLATE_SLUG` is the one score-only built-in.
        const { store, story, groups } = seedScoreStore();
        const opts = { groupRefs: groups.map((group) => group.id), vectorHash: selectionHashAt(groups, 1) };
        const asScheduled = compileSectionScorePrompt(store, story.id, {
            ...opts,
            templateSlug: 'reader-consistency'
        });
        const plain = compileSectionScorePrompt(store, story.id, opts);

        // The slug is the compiler's constant, not the caller's — and the fixture seeds exactly that row, which
        // is what makes the expected system string below the SCORE template's copy rather than a fallback.
        expect(SCORE_TEMPLATE_SLUG).toBe('reader-score');
        expect(store.templates.list().map((template) => template.name)).toContain(SCORE_TEMPLATE_SLUG);

        expect(asScheduled.system).toBe(
            `${READER_ROLE_PROMPT}\n\nAnswer with ONE JSON object matching the \`SectionScores\` schema. You have no tools and exactly one turn. No prose outside the JSON.`
        );
        expect(asScheduled.system).toBe(plain.system);
        expect(asScheduled.user).toBe(plain.user);
        expect(asScheduled.hash).toBe(plain.hash);

        // The decoy is in the catalogue, so this is a leak detector and not a tautology: the tool-using copy is
        // nowhere on the wire, and D-17a's stated absence sentence is absent too (the row WAS found, so the
        // seat is not being briefed by its output contract alone).
        expect(store.templates.list().map((template) => template.name)).toContain('reader-consistency');
        expect(`${asScheduled.system}\n${asScheduled.user}`).not.toContain(TOOL_READER_ROLE_PROMPT);
        expect(asScheduled.system).not.toContain('no role prompt from');
    });

    it('lets the evidence quote come from the section the scored one contradicts, and names it in the rationale (D-15)', () => {
        // WHY THE RULE MOVED: a cross-section fault's proof sits in the NEIGHBOUR — the Ending the Premise
        // earns is contradicted by a line in the Ending. Demanding the quote come from "that section" left a
        // Reader holding a real contradiction with two bad options: invent a line in the scored section, or
        // score the seam away. The answer schema still carries ONE `evidence` string per section, so the
        // licence to cross sections comes with the rule that the rationale says where the line came from —
        // otherwise the rail shows a quote the section it is filed under does not contain.
        const { store, story, groups } = seedScoreStore();
        const score = compileSectionScorePrompt(store, story.id, {
            groupRefs: groups.map((group) => group.id),
            vectorHash: selectionHashAt(groups, 1)
        });

        expect(score.user).toContain(
            'ONE `evidence` quote taken verbatim from the section you scored, or — for a cross-section fault — from ' +
                'the section it contradicts; when the line is not from the scored section, name the section it came from in `rationale`.'
        );
        expect(score.user).toContain(
            'The schema carries one `evidence` string per section, so the quote is the one line the judgement rests on, ' +
                'not a bundle of lines from several sections.'
        );

        // THE OLD WORDING IS GONE, and the cap on the quote is unchanged: two `evidence` mentions in this seat —
        // the rule, and the one-line-per-section limit that stops it becoming a bundle.
        expect(score.user).not.toContain('verbatim from that section');
        expect(score.user.match(/`evidence`/g)).toHaveLength(2);
    });

    it('refuses when the selection has gone — a stamped row is not selectable while a defect names its group', () => {
        const { store, story, groups } = seedScoreStore();

        // The Author APPROVES the fix, which is as open as `unconfirmed`/`confirmed` under D-33c's holding
        // set (`ISSUE_HOLDING_STATES`), so the stamp on the row survives (D-67 never revokes a verdict) while
        // the SELECTION goes — the open-issue half is a read, which is why there is no revocation
        // machinery (L-3). This is the veto half of the pair; the release half is the next test.
        const finding = store.findings.require('finding_0');

        store.findings.update(
            finding.id,
            { state: 'approved' },
            { ...AUTHOR_ATTR, why: 'seed: the Author approves the fix, so it stays open (D-33c)' },
            [{ id: finding.id, rev: finding.rev }]
        );

        expect(cleanSelectionOf(store, story).complete).toBe(false);

        expect(() =>
            compileSectionScorePrompt(store, story.id, {
                groupRefs: groups.map((group) => group.id),
                vectorHash: selectionHashAt(groups, 1)
            })
        ).toThrow(
            `compileSectionScorePrompt: story ${story.id} has no reviewed Summary to score — premise (no_clean_revision) lacks a clean revision (D-67)`
        );
    });

    it('selects the stamped row again once the defect is DISPUTED — a disputed issue releases the selection (D-33c, D-67)', () => {
        const { store, story, groups } = seedScoreStore();

        // THE OTHER HALF OF THE DOCTRINE, at the selection layer: `disputed` is not a defect, it is the
        // Editor saying the note does not fit the text. The stamp is untouched — D-67 never revokes a
        // verdict — and the group is selectable again, so a disputed row cannot wedge a group-mode book
        // between passes (the deadlock this change removes). Same seed, same stamps as the veto test,
        // ONLY the finding's state different: the pair pins the boundary of the holding set, not the rig.
        const finding = store.findings.require('finding_0');

        store.findings.update(
            finding.id,
            { state: 'disputed' },
            { ...AUTHOR_ATTR, why: 'seed: the Author disputes the fix (D-33c release)' },
            [{ id: finding.id, rev: finding.rev }]
        );

        const selection = cleanSelectionOf(store, story);

        // Complete, and the selection is the stamped vector — the numbers the rows were stamped under.
        expect(selection.complete).toBe(true);
        expect(selection.gaps).toEqual([]);
        expect(selection.vector_hash).toBe(selectionHashAt(groups, 1));

        // And the prompt really compiles against it: the refusal the veto test asserted is gone.
        const compiled = compileSectionScorePrompt(store, story.id, {
            groupRefs: groups.map((group) => group.id),
            vectorHash: selectionHashAt(groups, 1)
        });

        expect(compiled.user).toContain('## REVIEWED OVERVIEW — every section, scored (name each group_ref exactly once)');
    });

    it('refuses a hash whose selection has moved, and compiles the newer selection under its own hash', () => {
        const { store, story, groups } = seedScoreStore();
        const claimed = selectionHashAt(groups, 1);

        // A second deep pass clears the newer batch between the seat's claim and its dispatch: the
        // selection ADVANCES to number 2, so the bytes this seat claimed are no longer what the crew
        // stands behind. Recording the old hash against the new text would be a silent lie; refusing
        // costs one attempt and the seat re-arms on the new hash (`loop/work.ts` candidate 2b).
        installBatch(store, story, LATER_TEXTS, 'run_2');

        const advanced = stampCurrentVector(store, story, 'run_check_2');

        expect(advanced.stamped.map((revision) => `${revision.group_key}:${revision.number}`)).toEqual([
            'premise:2',
            'promise:2',
            'theme:2',
            'tone:2',
            'ending:2'
        ]);
        expect(cleanSelectionOf(store, story).vector_hash).toBe(selectionHashAt(groups, 2));

        expect(() =>
            compileSectionScorePrompt(store, story.id, {
                groupRefs: groups.map((group) => group.id),
                vectorHash: claimed
            })
        ).toThrow(
            `compileSectionScorePrompt: story ${story.id}'s reviewed Summary moved from ${claimed} to ${selectionHashAt(
                groups,
                2
            )} between the seat's claim and its dispatch (D-67)`
        );

        // The refusal is a re-arm, not a dead end: asked for the hash the moved selection now carries,
        // the compiler shows the NEW clean text — it follows the selection, and never the live row.
        const moved = compileSectionScorePrompt(store, story.id, {
            groupRefs: groups.map((group) => group.id),
            vectorHash: selectionHashAt(groups, 2)
        });

        expect(moved.user).toContain(reviewedBlock(groups, 2, LATER_TEXTS));
        expect(moved.user).not.toContain(reviewedBlock(groups, 1, GROUP_TEXTS));
        expect(moved.user.match(/revision=\d/g)).toEqual([
            'revision=2',
            'revision=2',
            'revision=2',
            'revision=2',
            'revision=2'
        ]);
    });
});

describe('phase1-prompt — the group prompts stay the five groups (R1)', () => {
    it('never puts the deprecated world_rules field in front of a group run', () => {
        const { store, story, groups } = seedGroupStore();
        const legacy = store.summaries.require('summary_0').world_rules ?? '';

        // The fixture's premise: the legacy field DOES hold a distinctive sentence, so the assertions below
        // are a leak detector and not a tautology over an empty field.
        expect(legacy).toBe('LEGACY WORLD RULES FIELD — must never reach a group prompt');

        const draft = compileGroupDraftPrompt(store, story.id, { groupRefs: groups.map((group) => group.id), fixRefs: ['task_0'] });
        const review = compileGroupReviewPrompt(store, story.id, { groupRefs: groups.map((group) => group.id), fixRefs: ['task_0'] });

        for (const compiled of [draft, review]) {
            expect(compiled.user).not.toContain('LEGACY WORLD RULES');
            // Five group sections and no sixth one: `world_rules` is not a group (R1), and the one place the
            // word appears is the Seed Brief's own bullet list.
            expect(compiled.user.split('\n').filter((line) => line.startsWith('### '))).toHaveLength(5);
            expect(compiled.user).not.toContain('key=world_rules');
            expect(compiled.user.match(/world_rules/g)).toHaveLength(1);
        }
    });
});

// ---------------------------------------------------------------------------
// PHRASE GROUP LOCK (R-lock, T6b) — two things this file is the only place that can prove:
//
//   1. THE MARKING REACHES EVERY CREW PROMPT, and reaches it identically. The whole point of a lock is
//      that four sections become law for the fifth, which only holds if the Writer, the reviewer and the
//      Reader all read the same sentence about the same section. A renderer branch that fired for one
//      prompt and not another would keep the loop consistent while the MODELS disagreed — the failure
//      mode R7 exists to prevent, and the failure mode a "contains LOCKED" sniff would not catch.
//   2. THE LOCK SEAT'S OWN TURN says what a judgement is: the exact clean revision, the Reader's REASON
//      (not the number as a gate), the live claims, the fixed point, and one answer. The boundary throws
//      are part of the contract: between the seat's claim and its dispatch the Setting can go off or the
//      reviewed Summary can advance, and a compiler that guessed would put a stale Overview in front of a
//      pass being asked to freeze it.
// ---------------------------------------------------------------------------

/** One group's LOCKED marker, exactly as `renderGroupEntry` prints it (the row's own numbers). */
const lockedMarker = (number: number, by: string): string =>
    `LOCKED at revision ${number} by ${by} — signed-off, FIXED text: quote it as the evidence the other sections must match, and never propose replacing a sentence of it, because the engine refuses any rewrite of this section and the answer that tries one is refused whole.`;

/** `joinSections`' output split back into its `## ` blocks, so ORDER can be asserted, not just presence. */
const userSections = (user: string): Array<{ heading: string; body: string }> =>
    user
        .split('\n\n## ')
        .map((part, index) => {
            const [heading, ...rest] = part.split('\n');

            return { heading: index === 0 ? heading : `## ${heading}`, body: rest.join('\n') };
        });

/**
 * Four of five sections locked, the fifth still writable — the shape a locking book actually lives in,
 * and the one that proves a lock never stops the loop: the unlocked section is still a full prompt.
 */
function seedMostlyLockedStore() {
    const world = seedScoreStore();
    const { store, story, groups } = world;

    for (const group of groups.slice(0, 4)) {
        // The Author's own lock: `locks.ts` keeps the unlock Author-only, and an editor lock would need the
        // Setting, which the crew-prompt fixtures deliberately do not turn on. Rows are re-read per call.
        lockPhraseGroup(
            store,
            store.stories.require(story.id),
            group.id,
            { ...AUTHOR_ATTR, why: `seed: the Author signed ${group.key} off as finished text (R-lock)` },
            { actor: 'author' }
        );
    }

    return { ...world, locked: groups.slice(0, 4), open: groups[4] };
}

describe('phase1-prompt — every crew prompt marks the locked sections (R-lock, T6b)', () => {
    it('marks the four locked sections in the Writer, the reviewer and the Reader, and leaves the fifth answerable', () => {
        const { store, story, groups, locked, open } = seedMostlyLockedStore();

        // Precondition, stated rather than assumed: the lock is on four rows and the fifth is untouched.
        expect(locked.map((group) => store.phraseGroups.require(group.id).locked)).toEqual([true, true, true, true]);
        // An UNLOCKED row leaves the flag out entirely (`PhraseGroup.locked` is absent, not `false` — that
        // is what `isPhraseGroupLocked` reads), so a fixture that wrote `false` would not be the same book.
        expect(store.phraseGroups.require(open.id).locked).toBeUndefined();

        const draft = compileGroupDraftPrompt(store, story.id, { groupRefs: [open.id], fixRefs: [] });
        const draftSections = userSections(draft.user);

        // THE WRITER: it is shown ONE answerable section — the locked four are not in its batch, and an
        // answer that named one would have its whole batch refused (`installGroupRevisions` rejects locked
        // groups), so a heading for a locked group here would be an invitation to lose the pass.
        const groupsSection = draftSections.find((section) => section.heading.startsWith('## GROUPS '));

        expect(groupsSection?.body.split('\n').filter((line) => line.startsWith('### '))).toEqual([
            `### ${phraseGroupDefinition('ending')?.title} (group_ref=${open.id}, key=ending, revision=1)`
        ]);
        // The batch's own group is unlocked, so it carries no marker.
        expect(groupsSection?.body).not.toContain('LOCKED at revision');

        // THE FIXED POINT: exactly one block, and it comes AFTER `## GROUPS` — both halves of the answer are
        // a question about the batch, and the note under the block points at groups the model has just read
        // (it also keeps the prompt's first `group_ref=` an answerable one — `loop/mock.ts:groupJobOf`).
        const peersSections = draftSections.filter((section) => section.heading.startsWith('## LOCKED PEERS'));

        expect(peersSections).toHaveLength(1);
        expect(draftSections.findIndex((s) => s.heading.startsWith('## GROUPS '))).toBeLessThan(
            draftSections.findIndex((s) => s.heading.startsWith('## LOCKED PEERS'))
        );
        expect(peersSections[0].heading).toBe(
            '## LOCKED PEERS (signed-off sections this pass may NOT rewrite — the facts your groups must match)'
        );

        // All four, in CATALOG ORDER, each with its own marker line and its own signed-off text.
        const peerLines = peersSections[0].body.split('\n');

        expect(peerLines.filter((line) => line.startsWith('### '))).toEqual(
            locked.map(
                (group) =>
                    `### ${phraseGroupDefinition(group.key)?.title} (group_ref=${group.id}, key=${group.key}, revision=1)`
            )
        );
        expect(peerLines.filter((line) => line.startsWith('LOCKED at revision'))).toEqual([
            lockedMarker(1, 'author'),
            lockedMarker(1, 'author'),
            lockedMarker(1, 'author'),
            lockedMarker(1, 'author')
        ]);
        // The block ends with the engine-owned note, so the "what do I do with a locked section" rule is the
        // same sentence in the Writer's, the reviewer's and the Editor's prompts.
        expect(peerLines[peerLines.length - 1]).toBe(
            'Every section above is LOCKED: the text is signed off, and neither this pass nor any later one can rewrite it (the engine refuses the whole batch that tries). Treat its facts as the facts your own sections have to agree with, and answer a FIX TASK that names one of these sections in the unlocked groups you are being shown, not in the locked text.'
        );

        // THE REVIEWER: it reads all five (a locked section is still reviewable — an unlocked one can
        // contradict it), so all five headings print and four of them carry the marker.
        const review = compileGroupReviewPrompt(store, story.id, { groupRefs: [], fixRefs: [] });
        const reviewLines = review.user.split('\n');

        expect(reviewLines.filter((line) => line.startsWith('### '))).toHaveLength(5);
        expect(reviewLines.filter((line) => line.startsWith('LOCKED at revision'))).toEqual([
            lockedMarker(1, 'author'),
            lockedMarker(1, 'author'),
            lockedMarker(1, 'author'),
            lockedMarker(1, 'author')
        ]);
        // Its own rule sentence, verbatim, after the attribution rules it qualifies.
        expect(review.user).toContain(
            'A group the OVERVIEW marks `LOCKED` is signed-off, FIXED text: the loop cannot rewrite it, and the Author alone unlocks it. Judge the Overview with that section as the baseline — its facts are the facts the other four must keep — and put the change where change is possible: name in `group_refs` the UNLOCKED group or groups that have to move so the Overview agrees with the locked one. A defect whose only home is a locked sentence is not work this book can do, so report it as what it is (a cost already paid) rather than as a repair the Writer owes.'
        );

        // THE READER: the score keeps counting the locked sections (the rail shows the trend), but a
        // deduction for a change nothing may make is a number the Author cannot act on.
        const score = compileSectionScorePrompt(store, story.id, {
            groupRefs: groups.map((group) => group.id),
            vectorHash: selectionHashAt(groups, 1)
        });
        const scoreLines = score.user.split('\n');

        expect(scoreLines.filter((line) => line.startsWith('LOCKED at revision'))).toEqual([
            lockedMarker(1, 'author'),
            lockedMarker(1, 'author'),
            lockedMarker(1, 'author'),
            lockedMarker(1, 'author')
        ]);
        expect(score.user).toContain(
            ' A section the heading marks `LOCKED` is signed-off, fixed text: score it exactly as written, and do not deduct for a change you would personally have made there, because no pass may make that change without the Author.'
        );
    });
});

describe('phase1-prompt — the Editor\u2019s lock seat compiles its judgement turn (R3, T6b)', () => {
    const EDITOR_LOCK_ROLE_PROMPT = 'You are the Editor weighing whether one section is finished.';
    const LOCK_ROLE_CONTRACT =
        'Answer with ONE JSON object matching the `GroupLockDecision` schema. You have no tools and exactly one turn. No prose outside the JSON.';
    const SCORE_RATIONALE = 'the ending pays the promise the premise makes, and nothing else in the Overview contradicts it';

    /**
     * A seat the Editor is actually entitled to take: the Setting on, the clean selection standing behind
     * revision 1 of every group, a Reader row for THIS group at THIS vector with a rationale, and no Writer
     * holding it. Every clause is a precondition the settle re-checks, so the fixture states them instead of
     * trusting a helper to have produced them.
     */
    function seedLockStore() {
        const world = seedScoreStore();
        const { store, story, groups } = world;
        const fresh = store.stories.require(story.id);

        store.stories.update(
            fresh.id,
            { editor_group_locking: true },
            { ...AUTHOR_ATTR, why: 'seed: the Author let the Editor freeze finished sections (R3)' },
            [{ id: fresh.id, rev: fresh.rev }]
        );
        seedTemplate(store, {
            name: 'editor-group-lock',
            roles: [{ name: 'editor', kind: 'editor', prompt: EDITOR_LOCK_ROLE_PROMPT }],
            serves_phase: ['summary']
        });

        const vector = selectionHashAt(groups, 1);
        const phrase = store.phrases.require(recordUidAt(1));

        store.summaryScores.create(
            {
                story_id: story.id,
                phrase_id: phrase.id,
                vector_hash: vector,
                group_id: groups[4].id,
                group_key: 'ending',
                score: 76,
                rationale: SCORE_RATIONALE,
                evidence: GROUP_TEXTS.ending,
                run_ref: 'run_score_1',
                work_item_ref: `wi_score_sections_${vector}`
            },
            { ...AUTHOR_ATTR, why: 'seed: the Reader scored the clean Overview at this vector (D-65)' }
        );

        return { ...world, vector, candidate: groups[4] };
    }

    it('renders the candidate, the Reader\u2019s reason, the claims, the fixed point and one answer — in that order', () => {
        const { store, story, groups, vector, candidate } = seedLockStore();
        const compiled = compileGroupLockPrompt(store, story.id, { groupRef: candidate.id, vectorHash: vector });

        // The system turn is the seat's OWN template plus the contract, with no per-book content in front of
        // it (§5's cache rule; the slug is the seat's, so an Author editing the generic Editor copy cannot
        // lose the freeze's rules).
        expect(compiled.system).toBe(`${EDITOR_LOCK_ROLE_PROMPT}\n\n${LOCK_ROLE_CONTRACT}`);

        expect(userSections(compiled.user).map((section) => section.heading)).toEqual([
            '## SEED BRIEF',
            '## KNOWLEDGE — critical and high only',
            `## CANDIDATE SECTION — the one section this pass may lock (clean revision 1 of the reviewed Overview, vector ${vector})`,
            '## THE READER’S READING (the number AND the reason for it — weigh the reason)',
            '## OPEN CLAIMS (every unresolved issue and proposal against this section or the fixed point — this is what “no remaining issue” is judged against)',
            '## CLAIMS THIS SECTION HAS ALREADY ANSWERED (closed rows, for context only — an answered claim is not a reason to keep rewriting)',
            '## LOCKED PEERS (sections already signed off — the fixed point this section is finished RELATIVE to)',
            '## LOCK DECISION (the only answer this pass may give)'
        ]);

        const sections = userSections(compiled.user);
        const candidateSection = sections[2];

        // THE CANDIDATE: exactly one section, named by the id the answer has to copy, at the clean revision
        // the lock would fix, and its text quoted from the CLEAN row.
        expect(candidateSection.body).toContain(`### ${phraseGroupDefinition('ending')?.title} (group_ref=${candidate.id}, key=ending, revision=1)`);
        expect(candidateSection.body).toContain(GROUP_TEXTS.ending);
        expect(candidateSection.body.split('\n').filter((line) => line.startsWith('### '))).toHaveLength(1);

        // THE READER'S READING: the row in full — and the seat is told the number is not the decision.
        expect(sections[3].body.split('\n').slice(0, 5)).toEqual([
            'score: 76/100',
            `rationale: ${SCORE_RATIONALE}`,
            `evidence: ${GROUP_TEXTS.ending}`,
            `vector: ${vector} (the same vector this seat is about)`,
            'run: run_score_1'
        ]);
        expect(sections[3].body.split('\n').pop()).toBe(
            'This is one Reader\'s reading of one section, not a rule and not a verdict. What you are being asked to weigh is the `rationale`: the Reader\'s own sentence about why the section holds or does not, and the line it quoted. A rationale that points at a seam you can find in the text above is a live claim; a rationale that names only something the Reader would personally have phrased differently is a taste, and a taste is not a defect at this phase.'
        );

        // THE CLAIMS: nothing open names this section (the fixture's one finding is premise-scoped and
        // closed), and the empty state is stated in words rather than left as a blank block the model would
        // read as "the prompt forgot to look".
        expect(sections[4].body).toBe(
            '(no unresolved claim names this section or any locked one — nothing is currently asking this text to change)'
        );
        expect(sections[5].body).toBe('(none — no closed claim names this section)');

        // THE FIXED POINT: nothing is locked yet, so this seat would take the book's FIRST lock, and the four
        // sections that stay writable are named by key — the Editor is allowed to leave one unlocked only
        // while it can see that the loop still has somewhere to move.
        expect(sections[6].body).toBe(
            '(no other section is locked yet — locking this one would make it the first fixed point the rest of the Overview is revised against)\nthe sections still unlocked, which keep being rewritten whichever way you answer: premise, promise, theme, tone'
        );

        // THE ANSWER CONTRACT: engine-owned, so the two halves of the judgement and the refusal of a
        // number-driven lock are the same sentences for every seat in every book (R7).
        const decision = sections[7].body.split('\n');

        expect(decision[0]).toBe(
            'ANSWER FOR THE CANDIDATE SECTION ONLY, and decide one thing: is that section FINISHED? Copy its `group_ref` from the heading above into `group_ref`.'
        );
        expect(decision).toContain(
            '- The Reader\u2019s number is not the decision, and no number locks a section by itself. Weigh its REASON, and do not restate the number: 92 whose rationale names a seam is a section that still owes work, and 70 whose rationale names only a preference the Reader would personally have changed is not, on its own, a reason to withhold the lock. An answer that only repeats the score back is not a decision and will be refused.'
        );
        expect(decision[decision.length - 1]).toBe(
            '- This pass decides ONE section. It may not lock or comment out another group, propose a rewrite, edit anything or file a finding: it has no tools, and the other sections have their own seats.'
        );
        // No threshold anywhere: the Author chose judgement over a cutoff, so a number that could decide by
        // itself must not appear as a rule. (`70`/`92` above are illustrations of a rationale, not gates.)
        expect(compiled.user).not.toMatch(/lock at|threshold|at least \d+|score of \d+ (is|locks)/);
    });

    it('refuses a seat whose Setting went off between the claim and the dispatch, and writes nothing', () => {
        const { store, story, vector, candidate } = seedLockStore();
        const fresh = store.stories.require(story.id);

        store.stories.update(
            fresh.id,
            { editor_group_locking: false },
            { ...AUTHOR_ATTR, why: 'seed: the Author took the Editor\u2019s lock away again (R3)' },
            [{ id: fresh.id, rev: fresh.rev }]
        );

        // The sentence names every precondition, because an Author reading the refusal has to be able to tell
        // which one moved; `absent = disabled` is stated so the Setting cannot be guessed at.
        expect(() => compileGroupLockPrompt(store, story.id, { groupRef: candidate.id, vectorHash: vector })).toThrow(
            new Error(
                `compileGroupLockPrompt: ${candidate.id} is not lockable by the Editor right now — story ${story.id} needs \`editor_group_locking\` on, a COMPLETE reviewed Summary whose entry for this group is its current text, a Reader score for this group at that exact vector, and no live Writer over it (R-lock)`
            )
        );
    });

    it('refuses a seat whose reviewed Summary advanced, rather than freezing a text nobody judged', () => {
        const { store, story, vector, candidate } = seedLockStore();

        // The seat was claimed against a vector that no longer exists — a Writer install, or a deep pass that
        // cleared another section, moves the selection's hash. Freezing on the new rows under the old key
        // would fix a revision the Editor never read.
        expect(() => compileGroupLockPrompt(store, story.id, { groupRef: candidate.id, vectorHash: 'vec-gone' })).toThrow(
            new Error(
                `compileGroupLockPrompt: story ${story.id}'s reviewed Summary moved from vec-gone to ${vector} between the seat's claim and its dispatch (R-lock)`
            )
        );
    });
});
