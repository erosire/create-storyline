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
import { AUTHOR_ATTR, seedStory, seedTask, seedTemplate } from './mock';

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

    seedTask(store, story.id, {
        kind: 'fix',
        title: 'pay the promise',
        detail: 'the ending does not pay it',
        priority: 30,
        criterion_ref: 'C-14'
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
        // what "improve it, do not abandon it" needs (§6.8). `base.id` is deliberately absent.
        expect(compiled.user).toContain(
            '## BASE REVISION (the selected draft of the previous round — improve it, do not abandon it)\n' +
                'premise: A return to a mapped valley.\n' +
                'promise: The map reconciles.\n' +
                'theme: Memory against measurement.\n' +
                'tone: Plain.\n' +
                'ending: She floods it.\n' +
                'world_rules: No magic.'
        );

        // Priority DESC (`task_1` at 30 before `task_2` at 10), the closed task excluded, and
        // `criterion_ref` stated because the fix must answer a named criterion (G-2, D-15).
        expect(compiled.user).toContain(
            '## FIX TASKS (every one must be visible in the new draft)\n' +
                '[task_1 · priority 30] pay the promise: the ending does not pay it [criterion C-14]\n' +
                '[task_2 · priority 10] name the river [criterion C-15]'
        );
        expect(compiled.user).not.toContain('done one');
        expect(base.round).toBe(1);
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
        const compiled = compileScreenPrompt(store, story.id, target.id);

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
                'Report ONLY critical and high issues: a critical contradicts the Seed Brief or a critical Knowledge entry; ' +
                'a high fails to deliver something the Seed Brief promises. Quote the offending field verbatim in `quote`, ' +
                'name the field in `location`, cite `C-14`, `C-15` or `seed` in `criterion`. Minor and taste notes are not ' +
                'reported. Return {"issues":[]} when the draft holds.'
        );

        // A screen is not a refinement: no base revision, no fix tasks, and no sibling sample or
        // revision id (D-21 keeps the other drafts out of a Reader's view).
        expect(compiled.user).not.toContain('## BASE REVISION');
        expect(compiled.user).not.toContain('## FIX TASKS');
        expect(compiled.user).not.toContain(target.id);
        expect(compiled.user).not.toContain(base.id);
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
