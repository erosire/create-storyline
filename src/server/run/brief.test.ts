// W5 acceptance for the brief (S-2, E-1, E-3, D-13, D-21, D-29, G-4, §4.13 `brief_hash`).
//
// Every assertion is an EXACT value, because the brief is an audit artifact: `runs.brief_hash`
// records what a run was told, and D-12a's "any past Digest is reconstructible" only holds if this
// text is a pure function of stored state. Fuzzy assertions here would hide the two failure modes
// the design actually has — a section silently missing (D-13: the run goes and reads the book), and
// a section whose wording moves between assemblies (which makes `brief_hash` useless as a key).
import { Store, type Attribution } from '../store';
import { hashBrief, buildBrief, assembleBrief, BRIEF_CHAR_BUDGET, REVISIONS_HEADING } from './brief';
import { resolveHarness } from './harness';
import {
    AUTHOR_ATTR,
    seedChapter,
    seedDigest,
    seedGoal,
    seedIdea,
    seedPlotline,
    seedRevision,
    seedStory,
    seedTask,
    seedTemplate
} from './mock';
import type { WorkItem } from './types';

/** The §4.13 attribution a run's own bookkeeping carries (P11). */
const RUN: Attribution = { run_ref: 'run_1', why: 'lease heartbeat (S-4a)' };

/**
 * A seeded Story in the state a `check_unit` job arrives at: Story + Summary + Goal + Digest +
 * plotline + two chapters, one of which carries prose nobody but this chapter's crew may see.
 *
 * Ids are the store's own minted values (`story_1`, `summary_1`, `chapter_1`, …), which is what
 * makes every assertion below an exact one.
 */
function seedStore(options: { digests?: number; drafts?: number; draftLength?: number; chapters?: number } = {}) {
    const store = Store.empty();
    const story = seedStory(store);
    const goal = seedGoal(store, story.id);

    seedDigest(store, story.id, 'Maren reaches the ridge; the map is wrong; the town is under water.');

    const plotline = seedPlotline(store, story.id);
    const chapter = seedChapter(store, story.id, { plotline_ref: plotline.id });

    // The second chapter exists to prove E-1: its prose must NOT reach a brief, and for a
    // whole-Story job only its one line may.
    const other = seedChapter(store, story.id, {
        order: 2,
        title: 'The Reservoir',
        summary: 'Maren walks the drowned street.',
        sections: [
            {
                id: 'sec_1',
                text: 'SECOND CHAPTER PROSE — the drowned church bell rings under the water.',
                origin: 'writer'
            }
        ]
    });

    const template = seedTemplate(store, {
        name: 'checker-consistency',
        roles: [
            {
                name: 'checker',
                kind: 'checker',
                prompt: 'You hunt setup-payoff debt across the unit. Every failing criterion needs an evidence line (D-15).'
            }
        ],
        done_definition: 'every criterion has a verdict and every failure has a task'
    });

    // The competing drafts a `select` brief is allowed to show and no other kind is (D-21).
    const drafts = Array.from({ length: options.drafts ?? 0 }, (_unused, index) =>
        seedRevision(
            store,
            story.id,
            chapter.id,
            `DRAFT ${index + 1} — ${'x'.repeat(options.draftLength ?? 40)}`,
            `run_${index + 2}`
        )
    );

    return { store, story, goal, plotline, chapter, other, template, drafts };
}

/** The Work Item the sweep would hand a `check_unit` job (S-1: one job, one run). */
function itemFor(overrides: Partial<WorkItem> = {}): WorkItem {
    return {
        id: 'work_1',
        storyId: 'story_1',
        kind: 'check_unit',
        templateRef: 'checker-consistency',
        roleName: 'checker',
        unit: { kind: 'chapter', ref: 'chapter_1' },
        ...overrides
    };
}

describe('brief — S-2 assembly', () => {
    it('renders S-2’s section list in order, and nothing else', () => {
        const { store } = seedStore();
        const item = itemFor();
        const brief = assembleBrief(store, item, resolveHarness(store, item));

        // Exact heading list, in render order: this is the assertion surface for "the brief is
        // self-contained" (S-2) — a missing section is a run that has to go look, which is D-13's
        // failure mode.
        expect(brief.sections).toEqual([
            'ROLE — checker (checker) of checker-consistency',
            'PHASE AND GOAL CRITERIA — Cold Mountain',
            'SEED — Author truth, read-only for you at every phase, forever',
            'DIGEST rev 1 (derived by the engine, never a crew: D-12a)',
            'ARTIFACT UNDER REVIEW — chapter chapter_1 — The Return (order 1, state drafting)',
            'THE JOB',
            'WHAT CHANGED SINCE THE LAST PASS',
            'SELECTED IDEAS THIS RUN MUST ABSORB (D-29 — selected, not yet written in)',
            'TOOLS AND HOW TO END'
        ]);
    });

    it('carries the role prompt, the phase question, the criteria, the Seed and the Digest verbatim (S-2, G-2, G-4, P5, D-13)', () => {
        const { store, story } = seedStore();
        const item = itemFor();
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain('You hunt setup-payoff debt across the unit.');
        expect(text).toContain('Done means: every criterion has a verdict and every failure has a task');
        // P4/D-13: the contract the prose must deliver is IN the brief, not one tool call away.
        expect(text).toContain('The contract this chapter must deliver (P4):');
        expect(text).toContain('must_happen: She sees the flooded church steeple.');
        // G-4: the Goal the whole crew is measured against, with P6's pass/fail rule.
        expect(text).toContain(
            'Goal "Consistent at every level, and written like mine": every HARD criterion must pass; at least 3 soft criteria must pass (P6: pass/fail with a citation, never a score).'
        );
        // G-2: a criterion arrives with its question and its fix hint, not just its id.
        expect(text).toContain(
            '- C-7 · HARD · you judge it\n  expanded prose delivers its chapter\u2019s `must_happen`\n  Q: Does the expanded prose deliver every event this chapter\u2019s must_happen names?\n  If it fails: Write the events the plotline names in this chapter; do not let an adjacent chapter do them instead.'
        );
        // C-12 sits outside the levels but is judged on every chapter (§5.2, PER_CHAPTER).
        expect(text).toContain('## Per chapter (outside the levels, \u00a75.2)');
        // P5/D-3b: the Seed is untouchable, and the brief says so where the agent reads it.
        expect(text).toContain(story.idea);
        expect(text).toContain('Maren reaches the ridge; the map is wrong; the town is under water.');
        // The job names the tool that reports it (S-4 is easier to obey when it is stated inline).
        expect(text).toContain('Judge the unit against the criteria above and report with `submitVerdict`');
    });

    it('names the unit, the phase and the permission row so a fresh context knows what it may do (D-17a, T-1a)', () => {
        const { store } = seedStore();
        const item = itemFor();
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain(
            'You are a checker: you read and report — `submitVerdict`, `raiseFinding`, `createTask`, `editTask`, `requestAuthor` (T-1b).'
        );
    });

    it('carries the open tasks the job must clear and the selected Ideas it must absorb (S-2, D-11, D-29)', () => {
        const { store } = seedStore();

        seedTask(store, 'story_1');
        seedIdea(store, 'story_1', { unit_ref: 'chapter_1' });

        const item = itemFor({ taskRefs: ['task_1'] });
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        // Exact rendered lines — the queue (not a transcript) is the plan (D-11), and the brief has
        // to quote it correctly or the run works on the wrong thing.
        expect(text).toContain(
            'Tasks this job must clear (1):\n- task_1 [open, writer-prose, p1, C-4, 0 attempt(s)]: pay off the 1911 map in chapter 3'
        );
        expect(text).toContain(
            'SELECTED IDEAS THIS RUN MUST ABSORB (D-29 — selected, not yet written in)\n- idea_1 (direction, by reader-continuity, unverified)\nthe steeple bell should ring under the water'
        );
    });

    it('renders a missing Digest or Goal as a stated absence rather than a hole (T-6a, D-13, G-4)', () => {
        const store = Store.empty();
        const story = seedStory(store);

        seedChapter(store, story.id);

        const item = itemFor();
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain('(no Goal row for this Story — the built-in criteria below are all it has, G-4)');
        expect(text).toContain(
            '(no Digest record yet — this is the first pass. If you need one to judge, file a `digest_gap` finding, D-13.)'
        );
        // The headings survive an empty body: a trimmed or missing section stays visible (S-2).
        expect(text).toContain('# DIGEST (derived by the engine, never a crew: D-12a)');
    });

    it('shows the competing drafts to a select and a merge run only (D-21)', () => {
        const base = seedStore({ drafts: 2 });

        for (const kind of ['check_unit', 'write_unit', 'verify_findings'] as const) {
            const item = itemFor({ kind });
            const { text, sections } = buildBrief(base.store, item, resolveHarness(base.store, item));

            expect(sections.includes(REVISIONS_HEADING)).toBe(false);
            expect(text.includes('revision_id=revision_1')).toBe(false);
            // D-21 is about the draft BODIES, not just the ids: a Writer that can see its sibling's
            // prose converges, and a converging panel is not a panel (L-16).
            expect(text.includes('DRAFT 1')).toBe(false);
        }

        for (const kind of ['select', 'merge'] as const) {
            const item = itemFor({ kind });
            const { text, sections } = buildBrief(base.store, item, resolveHarness(base.store, item));

            expect(sections).toContain(REVISIONS_HEADING);
            // Side by side, in the stable id order, with each draft's verdicts named (T-2a needs the
            // verdicts to be readable at the moment of choice).
            expect(text).toContain(
                'revision_id=revision_1 · state=competing · verdicts: none\nDRAFT 1 — ' + 'x'.repeat(40)
            );
            expect(text).toContain(
                'revision_id=revision_2 · state=competing · verdicts: none\nDRAFT 2 — ' + 'x'.repeat(40)
            );
        }
    });

    it('keeps another chapter’s prose out of the brief and carries its one line instead (E-1, D-13)', () => {
        const { store } = seedStore();

        // A whole-Story job: the chapter LIST is the artifact, one line per chapter (E-1). The prose
        // of every chapter in one brief is context rot re-imported through the front door (P2).
        const whole = itemFor({ kind: 'whole_story_check', unit: undefined });
        const wholeBrief = buildBrief(store, whole, resolveHarness(store, whole));

        expect(wholeBrief.text).toContain('- chapter_1 · 1 · The Return [drafting, round 1, no selected revision]');
        expect(wholeBrief.text).toContain('- chapter_2 · 2 · The Reservoir [drafting, round 1, no selected revision]');
        expect(wholeBrief.text.includes('SECOND CHAPTER PROSE')).toBe(false);
        expect(wholeBrief.text.includes('The ridge was where she had put the ridge.')).toBe(false);

        // A chapter job: exactly one chapter's prose, and never its sibling's (D-21 for the drafts,
        // E-1 for the rest of the book).
        const chapterItem = itemFor();
        const chapterBrief = buildBrief(store, chapterItem, resolveHarness(store, chapterItem));

        expect(chapterBrief.text).toContain('The ridge was where she had put the ridge.');
        expect(chapterBrief.text.includes('SECOND CHAPTER PROSE')).toBe(false);
    });

    it('quotes the journal for "what changed since the last pass", and never a run row (S-2, P11, P3)', () => {
        const { store, chapter } = seedStore();

        // An ordinary Author edit (D-12: the crew absorbs it on the next pass) — attributed, with a
        // `why`, which is exactly what the section is made of.
        store.chapters.update(
            chapter.id,
            { summary: 'Maren reaches the ridge and lies about it.' },
            {
                run_ref: null,
                author: true,
                why: 'the Author changed the chapter summary by hand'
            }
        );

        // A spawned run row plus a heartbeat: bookkeeping, not a story fact (P3), and excluded so
        // `brief_hash` cannot depend on when the run was spawned.
        store.runs.create(
            {
                story_id: 'story_1',
                work_item_ref: 'work_1',
                template_ref: 'checker-consistency',
                role: 'checker',
                session_ref: '',
                state: 'spawning',
                started_at: new Date().toISOString(),
                tokens: 0,
                kind: 'work',
                no_op: false,
                delegated: []
            },
            RUN
        );
        store.runs.update('run_1', { state: 'working' }, RUN);

        const item = itemFor();
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain('- update chapter_1: the Author changed the chapter summary by hand');
        expect(text.includes('run_1')).toBe(false);
        expect(text.includes('lease heartbeat')).toBe(false);
        // The unit-touching note outranks an unrelated one (E-3: the context of THIS job).
        expect(text.indexOf('- update chapter_1')).toBeLessThan(text.indexOf('- create story_1'));
    });

    it('trims the change notes and clips fields before it would ever drop the reading (E-3, E-0, D-13)', () => {
        // Forty drafts at 2k each: even the last rung of the ladder (400 characters per field) cannot
        // fit them, so the brief goes OVER budget with the Seed, the Digest, the criteria and the
        // artifact intact — E-0 forbids trading a rule for a number.
        const { store } = seedStore({ drafts: 40, draftLength: 2_000 });
        const item = itemFor({ kind: 'select' });
        const brief = buildBrief(store, item, resolveHarness(store, item));

        // Ten 40k drafts cannot fit; the ladder reaches its last rung and clips EVERY draft body,
        // which the clip marker makes countable — one marker per draft, so a section that quietly
        // disappeared instead of being clipped would fail here (S-2's trim must stay visible).
        expect(brief.text.match(/clipped for the brief/g)?.length).toBe(40);
        // The clip is exactly the last rung's 400 characters of body: the `DRAFT 1 — ` label is 10
        // characters, so 390 of the filler survive. Exact, because E-3 is a bound, not an estimate.
        expect(/DRAFT 1 — (x+)/.exec(brief.text)?.[1]).toHaveLength(390);
        // …and drops the change notes entirely, with the heading kept so the trim is visible (S-2).
        expect(brief.text).toContain('(trimmed for brief size — the journal holds the rest)');
        expect(brief.sections).toContain('WHAT CHANGED SINCE THE LAST PASS');
        // E-0 in code: the Seed, the Digest, the criteria and the artifact stay in, and the brief
        // goes over budget rather than trading a rule for a number.
        expect(brief.text).toContain('SEED — Author truth, read-only for you at every phase, forever');
        expect(brief.text).toContain('DIGEST rev 1 (derived by the engine, never a crew: D-12a)');
        expect(brief.text).toContain('C-7 · HARD · you judge it');
        expect(brief.text).toContain(
            'ARTIFACT UNDER REVIEW — chapter chapter_1 — The Return (order 1, state drafting)'
        );
        expect(brief.text.length > BRIEF_CHAR_BUDGET).toBe(true);
    });

    it('is a pure function of stored state, so brief_hash survives re-assembly and a spawned run (D-12a, §4.13, S-4a)', () => {
        const { store, chapter } = seedStore({ drafts: 2 });
        const item = itemFor({ kind: 'select' });
        const harness = resolveHarness(store, item);

        const first = buildBrief(store, item, harness);
        const second = buildBrief(store, item, harness);

        expect(second.text).toBe(first.text);
        expect(second.hash).toBe(first.hash);
        expect(second.hash).toBe(hashBrief(second.text));

        // Spawn bookkeeping changes the store without changing what a run would be TOLD.
        store.runs.create(
            {
                story_id: 'story_1',
                work_item_ref: 'work_1',
                template_ref: 'checker-consistency',
                role: 'checker',
                session_ref: '',
                state: 'spawning',
                started_at: new Date().toISOString(),
                tokens: 0,
                kind: 'work',
                no_op: false,
                delegated: []
            },
            RUN
        );
        store.runs.update('run_1', { state: 'working', session_ref: 'sess_run_1', brief_hash: first.hash }, RUN);

        const third = buildBrief(store, item, harness);

        expect(third.text).toBe(first.text);
        expect(third.hash).toBe(first.hash);

        // A real story fact DOES change it — the hash is a content key, not a constant.
        store.chapters.update(chapter.id, { title: 'The Ridge' }, { run_ref: null, author: true, why: 'rename' });
        const fourth = buildBrief(store, item, harness);

        expect(fourth.hash === first.hash).toBe(false);
        expect(
            fourth.text.includes('# ARTIFACT UNDER REVIEW — chapter chapter_1 — The Ridge (order 1, state drafting)')
        ).toBe(true);
    });

    it('hashes with sha256, so the key is the one an auditor can recompute (§4.13)', () => {
        // The published sha256 of the empty string — an independent value, so the test does not
        // merely restate the implementation.
        expect(hashBrief('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(hashBrief('the Seed and the map')).toBe(
            'c3b6bd988675c4f06dd302d0d026d3115f466cbb21e76d992f62fae90000d757'
        );
    });
});
