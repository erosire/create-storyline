// §5 acceptance — the built-in criteria and the default Goal, checked against the §5.2 table
// transcribed HERE (independently of the implementation), because the table's checker and hard
// columns are normative: a build that flips one is wrong (G-3, §5.1).
import {
    BUILT_IN_CRITERIA,
    LEVELS,
    LEVEL_LABELS,
    LEVEL_QUESTIONS,
    PER_CHAPTER,
    criterionById,
    defaultGoal
} from './criteria';

/** §5.2's four columns, in the table's order. */
const SPEC_5_2: { id: string; label: string; checker: 'code' | 'judge'; hard: boolean }[] = [
    {
        id: 'C-0',
        label: 'the Story has exactly `chapter_count` plotlines and chapters — no more, no fewer',
        checker: 'code',
        hard: true
    },
    { id: 'C-1', label: 'every chapter has a plotline', checker: 'code', hard: true },
    {
        id: 'C-2',
        label: 'every plotline traces to the Summary — nothing in it contradicts premise, promise, theme, or ending',
        checker: 'judge',
        hard: true
    },
    {
        id: 'C-3',
        label: 'every plotline’s `must_change` is actually a change, not a restatement',
        checker: 'judge',
        hard: false
    },
    {
        id: 'C-4',
        label: 'plotlines are consistent with each other: no contradiction between adjacent chapters, no event requiring a setup that no earlier chapter makes',
        checker: 'judge',
        hard: true
    },
    {
        id: 'C-5',
        label: 'every `setup` in the ledger has a `payoff`, and every `payoff` has a setup',
        checker: 'code',
        hard: true
    },
    { id: 'C-6', label: 'timeline is monotonic; no `fact` contradiction', checker: 'code', hard: true },
    { id: 'C-7', label: 'expanded prose delivers its chapter’s `must_happen`', checker: 'judge', hard: true },
    { id: 'C-8', label: 'expanded prose delivers its chapter’s `must_change`', checker: 'judge', hard: true },
    {
        id: 'C-9',
        label: 'no character acts against `arc` + `state_now` without a scene that owns the change',
        checker: 'judge',
        hard: false
    },
    { id: 'C-10', label: 'the ending pays the `promise`', checker: 'judge', hard: true },
    { id: 'C-11', label: 'no two consecutive chapters do the same job (pacing)', checker: 'judge', hard: false },
    { id: 'C-12', label: 'prose quality at the level the `tone` sheet demands', checker: 'judge', hard: false },
    {
        id: 'C-13',
        label: 'the prose reads as though this Author wrote it — matches the `tone` sheet and the Editor templates’ `selection_rules`',
        checker: 'judge',
        hard: true
    },
    {
        id: 'C-14',
        // §5.2's C-14 row, re-cut by T3: the Seed is GENERAL, so this criterion is a contradiction
        // test, not a checklist. The old label ("nothing central to `stories.idea` is missing from
        // it") is what let Readers file the Author's two screenshot findings — a refuge with no
        // earlier planting, and a stake the Seed never stated — as C-14 defects. `checker` and `hard`
        // are unchanged; only the criterion's own wording moved, and the spec table row
        // (documents/specifications.md §5.2) carries this same text.
        label: 'the Summary delivers the Seed: nothing in it contradicts what the Seed states, and no commitment the Seed states explicitly goes unpaid',
        checker: 'judge',
        hard: true
    },
    {
        id: 'C-15',
        label: 'every Idea that reached a locked artifact was verified by an Editor and carries evidence',
        checker: 'code',
        hard: true
    }
];

describe('§5.2 — the built-in criteria', () => {
    it('C-0…C-15 match the table exactly (id, label, checker, hard)', () => {
        expect(BUILT_IN_CRITERIA.map(({ id, label, checker, hard }) => ({ id, label, checker, hard }))).toEqual(
            SPEC_5_2
        );
    });

    it('the code checkers are exactly the mechanical five — C-0, C-1, C-5, C-6, C-15 (G-3, D-10)', () => {
        expect(
            BUILT_IN_CRITERIA.filter((criterion) => criterion.checker === 'code').map((criterion) => criterion.id)
        ).toEqual(['C-0', 'C-1', 'C-5', 'C-6', 'C-15']);
    });

    it('every criterion has a label, a question, and a fix_hint (P4, G-2)', () => {
        const empty = BUILT_IN_CRITERIA.filter(
            (criterion) =>
                criterion.id.trim().length === 0 ||
                criterion.label.trim().length === 0 ||
                criterion.question.trim().length === 0 ||
                criterion.fix_hint.trim().length === 0
        ).map((criterion) => criterion.id);

        expect(empty).toEqual([]);
    });

    it('G-6: no criterion asks "is this good?" — every one is answerable against a stored artifact', () => {
        expect(
            BUILT_IN_CRITERIA.filter((criterion) => /\bis this good\b/i.test(criterion.question)).map(
                (criterion) => criterion.id
            )
        ).toEqual([]);
    });

    it('T3: C-14 is a contradiction test, and its own wording says Seed silence is not a defect', () => {
        // The failure this pins is the one the Author reported: a Reader spent a round on "the final
        // refuge has no earlier setup in the Summary" and another on "the Summary never says what the
        // bird loses" — both details a general Seed leaves open. The old label/question framed C-14 as
        // "nothing central … is missing from it", which made every silence an unmet promise, and the
        // fix_hint told the Writer to "carry everything central to the Seed". None of that survives.
        const c14 = criterionById('C-14');

        // The three fields are what a Reviewer and a fix task actually read: the brief renders label +
        // question + fix_hint together (`run/brief.ts`), and a fix task renders the hint as its
        // definition of done (`run/phase1-prompt.ts:renderFixTask`). `?.` keeps this strict-mode clean;
        // an absent C-14 makes every assertion below throw rather than pass quietly.
        const fields = [c14?.label, c14?.question, c14?.fix_hint];

        expect(fields.filter((text) => /nothing central|is missing from it|everything central/i.test(`${text}`))).toEqual(
            []
        );

        expect(c14?.label).toContain('nothing in it contradicts what the Seed states');
        expect(c14?.label).toContain('no commitment the Seed states explicitly goes unpaid');
        expect(c14?.question).toContain('the Writer may supply any detail the Seed does not rule out');
        expect(c14?.question).toContain('stakes it left open, setup the Summary did not promise');
        expect(c14?.fix_hint).toContain('Remove what contradicts the Seed');
        expect(c14?.fix_hint).toContain('so its absence is not a defect to fix');
        // The controls are NOT relaxed: an explicit commitment still fails the line, and the Seed stays
        // un-editable (P5) — the fix is always in the Summary.
        expect(c14?.question).toContain('a quote of what the Summary contradicts');
        expect(c14?.fix_hint).toContain('P5: the Seed is never edited to pass');
    });

    it("§5.2's levels: one per phase boundary plus the whole-Story pass", () => {
        expect(LEVELS).toEqual({
            summary: ['C-14', 'C-15'],
            plotlines: ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6'],
            chapters: ['C-7', 'C-8', 'C-9'],
            whole: ['C-10', 'C-11', 'C-13']
        });
    });

    it('C-12 sits OUTSIDE the levels as the per-chapter quality check (§5.2 closing note)', () => {
        expect(PER_CHAPTER).toEqual(['C-12']);

        const grouped = [...LEVELS.summary, ...LEVELS.plotlines, ...LEVELS.chapters, ...LEVELS.whole, ...PER_CHAPTER];

        // Levels + per-chapter cover all 16 criteria exactly once: no criterion is counted in
        // two levels, and none is invisible to the loop.
        expect(grouped.length).toBe(16);
        expect(new Set(grouped).size).toBe(16);
        expect([...grouped].sort()).toEqual(BUILT_IN_CRITERIA.map((criterion) => criterion.id).sort());
    });

    it('every level has the heading and question G-2 renders', () => {
        expect(Object.keys(LEVELS)).toEqual(Object.keys(LEVEL_QUESTIONS));
        expect(Object.keys(LEVELS)).toEqual(Object.keys(LEVEL_LABELS));
        expect(LEVEL_LABELS.summary).toBe('Seed → Summary');
        expect(LEVEL_QUESTIONS.whole).toBe('does the book pay its promise, hold its pace, and sound like the Author?');
    });

    it('criterionById resolves the ids G-2 prints in `failing: C-4, C-5`', () => {
        expect(criterionById('C-13')).toEqual(BUILT_IN_CRITERIA.find((criterion) => criterion.id === 'C-13'));
        expect(criterionById('C-16')).toBeUndefined();
    });
});

describe('§4.11 / G-5 — defaultGoal', () => {
    it('carries all 16 criteria and the three loop-detection numbers', () => {
        const goal = defaultGoal('story_1');

        expect(goal.story_id).toBe('story_1');
        expect(goal.threshold_soft).toBe(3);
        expect(goal.flat_rounds).toBe(3);
        expect(goal.regress_tolerance).toBe(2);
        expect(goal.criteria.map((criterion) => criterion.id)).toEqual(SPEC_5_2.map((criterion) => criterion.id));
    });

    it('G-5: no token field, no minute field, no round cap — nothing here can stop a loop', () => {
        const goal = defaultGoal('story_1');

        // The exact key set, so adding a budget-shaped field is a visible decision rather than
        // a quiet one (E-0 forbids any cost gate on a Goal).
        expect(Object.keys(goal).sort()).toEqual([
            'created_at',
            'criteria',
            'flat_rounds',
            'id',
            'regress_tolerance',
            'rev',
            'story_id',
            'threshold_soft',
            'title',
            'updated_at'
        ]);
    });

    it('hands out a CLONE of the roster, so one Author editing their Goal cannot edit everyone else’s (G-1)', () => {
        const goal = defaultGoal('story_1');

        goal.criteria[0].hard = false;
        goal.criteria[0].label = 'edited by the Author';

        expect(BUILT_IN_CRITERIA[0].hard).toBe(true);
        expect(BUILT_IN_CRITERIA[0].label).toBe(SPEC_5_2[0].label);
        expect(defaultGoal('story_2').criteria[0].hard).toBe(true);
    });
});
