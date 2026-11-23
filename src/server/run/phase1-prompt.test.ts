// Phase-1 prompt compiler acceptance (documents/phase-1-research-pipeline.md §5).
//
// WHY THE ASSERTIONS ARE EXACT STRINGS: `prompt_hash` is the audit key a Revision row carries (§3.5)
// and the reason a provider can serve the sampling prefix from cache (§5). Both promises die the
// moment the text is allowed to drift, so the fixture below pins the WHOLE `system` and `user`
// turns — not a "contains the heading" sniff that would pass while the bytes changed.
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import {
    compileSamplePrompt,
    compileScreenPrompt,
    hashPhase1Prompt
} from './phase1-prompt';
import { AUTHOR_ATTR, seedFinding, seedStory, seedTask, seedTemplate } from './mock';

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

/** The Seed Brief exactly as both prompts render it — the block every case below starts with. */
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
- who flooded the valley?`;

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
const FIX_TASK_BLOCK = `[task_1 · priority 30 · finding_1] pay the promise
  work: the ending does not pay it
  defect: nothing in the ending pays the promise the brief makes
  evidence: ending: She floods it. — no choice of the protagonist brings map and territory together
  criterion: C-14
  done looks like: Expand the Summary to carry everything central to the Seed, and remove what contradicts it (P5: the Seed is never edited to pass).
[task_2 · priority 10] name the river
  done looks like: Run verifyIdea (re-read the source, record evidence) before the lock, or keep the unverified Idea out of the artifact (D-27).`;

/**
 * H1/R6 — the screening contract, pinned verbatim. The calibration is the point: the two severities
 * are defined over consistency, causality, timeline, world rules, motive and the Seed's goal, and
 * phrasing is named as NOT reportable at this phase. Wording the prose carries is judged in phase ③.
 */
const SCREEN_CONTRACT =
    'Report ONLY critical and high issues, and reserve those two words for what a Summary has to get RIGHT: ' +
    'a critical contradicts the Seed Brief or a critical Knowledge entry — a causal chain that does not cause, ' +
    'a timeline that cannot happen, a world rule the draft states and then breaks, a motive that does not explain ' +
    'the acts it grounds, or an ending that fails the Seed’s goal. A high fails to deliver something the Seed ' +
    'Brief promises. Word choice, sentence structure, grammar, register and a preference for another phrasing of ' +
    'the same commitment are NOT issues at this phase — they are minor, nothing here ranks them, and the prose ' +
    'that carries them is written and judged in phase ③. Quote the offending field verbatim in `quote`, ' +
    'name the field in `location`, cite `C-14`, `C-15` or `seed` in `criterion`. Return {"issues":[]} when the ' +
    'draft holds.';

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

/** H1/R1 — the contract that keeps a refinement a revision (the loop's endless-rewrite fix). */
const REVISION_CONTRACT =
    '- Change only what the FIX TASKS require, and only the coordinated minimum: the passages whose facts, ' +
    'causal links, timeline or consequences the fix actually touches.\n' +
    '- Keep the base draft’s other commitments, fields and sentences as they are. A rewrite from scratch ' +
    'discards what the previous round already settled and starts the loop again — that is the round this ' +
    'pipeline exists to save.\n' +
    '- A fix is answered by the draft’s CONTENT. Restating the same commitment in other words answers none of ' +
    'the tasks and will be marked `unresolved`.\n' +
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
        const compiled = compileSamplePrompt(store, story.id, { round: 2, fixRefs: ['task_2'] });

        expect(compiled.user).toContain(
            '## FIX TASKS (every one must be visible in the new draft, by content, and each is judged by its id)\n' +
                '[task_2 · priority 10] name the river\n' +
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
            '## SEED\nThe raw Seed is the only truth here.\n(no structured brief yet — the Seed itself is law, P5)'
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

describe('phase1-prompt — the screening Reader (§6.4 step 4)', () => {
    it('carries the target draft’s fields and the critical/high-only screening contract', () => {
        const { store, story, base, target } = seedPhase1Store();
        // H1/R2: a round-1 screening job hands the Reader an EXPLICIT empty fix list (that is what
        // `fixRefs: []` means on the Work Item), so the verification sections stay out and the pass
        // costs exactly what it cost before fix verification existed (R5).
        const compiled = compileScreenPrompt(store, story.id, target.id, { fixRefs: [] });

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
        expect(compiled.user).not.toContain('## FIX TASKS');
        expect(compiled.user).not.toContain('fix_verifications');
        expect(compiled.user).not.toContain(target.id);
        expect(compiled.user).not.toContain(base.id);
    });

    it('H1/R2 — a refinement screen is given the draft it replaces and certifies every fix by id', () => {
        const { store, story, target } = seedPhase1Store();
        const compiled = compileScreenPrompt(store, story.id, target.id, { fixRefs: ['task_1', 'task_2'] });

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
                `${SCREEN_CONTRACT}\n\n${FIX_VERIFY_CONTRACT}`
        );

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
        // Naming an id would make the prompt depend on a value the caller picked, not on the book.
        expect(compiled.user).not.toContain('revision_999');
    });
});
