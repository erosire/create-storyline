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
    compileGroupReviewPrompt,
    compileSamplePrompt,
    compileScreenPrompt,
    hashPhase1Prompt,
    renderFixTask
} from './phase1-prompt';
import { AUTHOR_ATTR, seedFinding, seedStory, seedTask, seedTemplate } from './mock';
import { ensurePhraseCatalog } from '../phrase/catalog';
import { installGroupRevisions } from '../phrase/revisions';
import { recordUidAt } from '../store/persist';
import { phraseGroupDefinition } from '../../shared/phrase';
import type { PhraseGroup } from '../../shared/types';

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
        name: 'reader-screening',
        roles: [
            {
                name: 'reader',
                kind: 'reader',
                prompt: 'You are the screening Reader for phase ①. Report ONLY critical and high problems.'
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
 * R6 killed the PHRASING complaint (`high` for a comma, then a resample, then another Reader who disliked
 * the new wording — the hill with no top). T3 killed the ABSENCE complaint: the Author's two screenshots
 * were a refuge with no earlier planting in the Summary and a stake the Seed never stated, and the line
 * this replaces ("A high fails to deliver something the Seed Brief promises") read a general Seed as an
 * outline with unfilled boxes. The rule now names invention as allowed and makes the quote the test: an
 * absence cannot be quoted, so it is not admissible. The contradiction grounds stay, and so does the
 * requirement to name the field — this array is what the selection is gated on.
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
    '`location`, cite `C-14`, `C-15` or `seed` in `criterion`. Return {"issues":[]} when the draft holds.';

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
 * COMPARISON (a screen that was handed the accepted draft), not the fix list: the Reader can classify a
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
    // what it changes, because the screening Readers now compare the candidate with the accepted draft and
    // one NEW critical/high rejects it however much else it fixed (`sample-select.ts:scoreSample`).
    '- Breaking something the base draft got right is a NEW defect: the readers compare your draft with ' +
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

        // `normal`/`low` never enter the prefix — the deep-review Reader reads them via the tool.
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
     * One fix task over three findings that differ ONLY in the claim type: a marked `improvement`, a
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
            kind: 'improvement',
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
        // the Reader's complaint, and a sample that reads "nothing pays the promise" re-drafts the
        // paragraph instead of writing the better one that was proposed.
        expect(renderFixTask(task, proposal)).toBe(
            '[task_0 · priority 30 · finding_0] open on the lie\n' +
                '  work: move the lie into the first paragraph\n' +
                '  kind: improvement (a proposal, not a defect)\n' +
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

describe('phase1-prompt — the screening Reader (§6.4 step 4)', () => {
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
            'You are the screening Reader for phase ①. Report ONLY critical and high problems.\n\n' +
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
        // and no sibling sample or revision id (D-21 keeps the other drafts out of a Reader's view).
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
        // introduced (fail closed) — so a Reader that was never shown the accepted draft would be
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

        // The rule is asked in the order the Reader needs it: fix verdicts first (they decide the
        // certificate), then the origin of each issue it reports.
        expect(compiled.user.indexOf(FIX_VERIFY_CONTRACT)).toBeLessThan(compiled.user.indexOf(ISSUE_ORIGIN_INSTRUCTION));
        expect(compiled.user.indexOf(ISSUE_ORIGIN_INSTRUCTION)).toBeLessThan(compiled.user.length);

        // This is the same one-turn pass that ranks the round: no second pipeline, no second Reader
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
            name: 'reader-screening',
            serves_phase: ['summary'],
            roles: [{ name: 'reader', kind: 'reader', prompt: 'You read this Author\u2019s shelf. Report what is wrong.' }]
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
        // names, and the empty answer as a legitimate reply.
        expect(compiled.user).toContain('a critical contradicts the Seed Brief or a critical Knowledge entry');
        expect(compiled.user).toContain('A high leaves unpaid a commitment the Seed Brief states EXPLICITLY');
        expect(compiled.user).toContain('Quote the offending field verbatim in `quote`');
        expect(compiled.user).toContain('cite `C-14`, `C-15` or `seed` in `criterion`');
        expect(compiled.user).toContain('Return {"issues":[]} when the draft holds');
    });

    it('renders a silent Seed field as an open choice, never as a blank that reads like an unpaid promise', () => {
        const { store, story } = seedPhase1Store();

        // Overwrite the fixture's stated stakes with a brief whose Seed left them open — the shape the
        // structuring Editor is told to produce (`open_questions` carries the gap, the required field is
        // empty). A bare `stakes: ` line is what a Reader read as "the Summary never says what is lost".
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
//   2. ONLY the groups the job named are offered to the Writer, while the Reader is shown the WHOLE
//      Overview — a fix that rewrote a group nobody asked for would move four groups' neighbours under a
//      review that judged one (R2), and an issue about a group the Reader never saw cannot be attributed;
//   3. the FIX TASKS section follows the JOB's refs, and vanishes when the batch has none — in the review
//      its verification contract vanishes with it, because a Reader asked to certify fixes that were
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
        name: 'reader-screening',
        roles: [
            {
                name: 'reader',
                kind: 'reader',
                prompt: 'You are the screening Reader for phase ①. Report ONLY critical and high problems.'
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

/** The whole Overview block, in catalog order, exactly as the Reader is shown it. */
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
    '- Your own word that a defect is gone proves nothing: the next review decides, by quoting the installed group that shows the repair. Answer the whole defect in every group it names, or claim nothing.\n' +
    '- Nothing here is judged on style: wording and sentence shape are settled in phase ③, when the chapters are ' +
    'written.';

/** R3 — the group Reader's attribution rule, mirrored from `phase1-prompt.ts:GROUP_REVIEW_INSTRUCTION`. */
const GROUP_REVIEW_INSTRUCTION =
    'EVERY issue you report names its `group_refs`: the group ids shown in the OVERVIEW section above. Name the one ' +
    'group the defect is in; name several, or all five, when the defect is in how they fit together — a promise the ' +
    'Ending does not keep, a Theme the Premise never grounds. An issue that cannot name a group is not an answer this ' +
    'pass may give: the loop routes work by group, and a defect with no group is work nobody can do.\n' +
    // T3 — mirrored from the source: one defect = one issue, the quote carries its address, a multi-group
    // fix certifies only when every named group carries it, and a review is a read (R3/R5).
    'One defect that crosses several groups is ONE issue naming every group it crosses — never one issue per group, which would buy several rewrites of the same complaint. Say in `location` which group your `quote` came from and where in it the line sits: ids and headings are the address the Writer revises, prose summaries of the book are not. When the prompt carries FIX TASKS, a task whose finding names several groups is `resolved` only once EVERY one of those groups carries the repair — one group fixed is not the finding fixed. And this pass writes nothing: it spends none of the Story’s rewrite allowance, so report what you find without rationing.';

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
    it('shows the Reader the WHOLE Overview — all five groups, ids, revision numbers and text', () => {
        const { store, story, groups } = seedGroupStore();
        const compiled = compileGroupReviewPrompt(store, story.id, {
            groupRefs: groups.map((group) => group.id),
            fixRefs: ['task_0']
        });

        expect(compiled.system).toBe(
            'You are the screening Reader for phase ①. Report ONLY critical and high problems.\n\n' +
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
        // is shown, so the Reader still attributes its issues by group.
        const all = compileGroupReviewPrompt(store, story.id, { groupRefs: [], fixRefs: [] });

        expect(all.user).toContain(overviewBlock(groups));
        expect([...all.user.matchAll(/group_ref=/g)]).toHaveLength(5);

        // A seat aimed at two groups sees those two — and the prompt says which groups are IN SCOPE by
        // showing only them, rather than letting the Reader raise a defect it was never shown.
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

        // Without the fix list the certificate goes with it: a Reader asked for `fix_verifications` with no
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
