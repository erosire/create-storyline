// W3 acceptance — every test below pins a clause of §5/§12 W3, and the ids in the names are the
// spec's own so a failure reads as a spec violation rather than a broken assertion.
//
//   C-0 / C-1 / C-5 / C-6 / C-15 evaluate with NO model call (G-3, D-10)
//   a plotline count of 7 or 9 against `chapter_count` 8 fails C-0, naming the count (D-3b, L-6a)
//   a sourced Idea selected without an Editor verification fails C-15 (D-27)
//   judge aggregation honours the LATEST verdict per target (§4.9, D-15)
//   progress renders `n/m · failing: …` for the CURRENT phase only (G-2, §12 W3)
//   unreached levels are `n/a`, never `0/n` (L-14)
//   `bar_override` drops a criterion or moves the soft bar, and an invalid token is reported (G-1)
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Store, type Attribution } from '../store';
import type {
    Chapter,
    Criterion,
    Idea,
    LedgerEntry,
    LedgerKind,
    LedgerStatus,
    Plotline,
    Story,
    StoryPhase,
    Verdict,
    VerdictCriterion
} from '../../shared/types';
import { defaultGoal } from '../../shared/criteria';
import { CriteriaEngine, type CriterionResult } from './engine';

// The three attributions a real server produces (P11). Nothing here needs a run that talks to a
// model: the fixtures are writes, and the engine under test only reads them.
const AUTHOR: Attribution = { run_ref: null, author: true, why: 'author seeds the story' };
const WRITER: Attribution = { run_ref: 'run_1', why: 'writer produces the artifact' };
const CHECKER: Attribution = { run_ref: 'run_2', why: 'checker submits the verdict' };

// ---------------------------------------------------------------------------
// Fixtures — only the fields §4 marks required, so a test cannot invent a field and pass on it
// ---------------------------------------------------------------------------

function createStory(store: Store, phase: StoryPhase = 'plotlines'): Story {
    return store.stories.create(
        {
            title: 'The Reservoir',
            phase,
            idea: 'A cartographer returns to the valley she mapped as a girl and finds it redrawn by a reservoir.',
            summary_locked: phase !== 'summary',
            plotlines_locked: false,
            pending_kind: 'none',
            status: 'ready',
            trend: 'unknown',
            auto_approve: ['critical', 'major'],
            author_stop: false,
            digest_rev: 0,
            template_refs: [],
            chapter_deps: {}
        },
        AUTHOR
    );
}

function createSummary(store: Store, storyId: string, chapterCount: number): void {
    store.summaries.create(
        {
            story_id: storyId,
            chapter_count: chapterCount,
            premise: 'A mapmaker returns to a drowned valley.',
            promise: 'The valley gives back what it took.',
            locked: false
        },
        WRITER
    );
}

function createPlotline(store: Store, storyId: string, order: number): Plotline {
    return store.plotlines.create(
        {
            story_id: storyId,
            order,
            heading: `Beat ${order}`,
            must_happen: 'the map is burned',
            must_change: 'she no longer owns the valley',
            contract_locked: false,
            aligned: false,
            needs_recheck: false
        },
        WRITER
    );
}

function createChapter(store: Store, storyId: string, order: number, plotlineRef?: string): Chapter {
    return store.chapters.create(
        {
            story_id: storyId,
            plotline_ref: plotlineRef,
            order,
            title: `Chapter ${order}`,
            sections: [{ id: `section_${order}`, text: 'The water is still moving.', origin: 'writer' }],
            state: 'drafting',
            author_locked: false,
            round: 1
        },
        WRITER
    );
}

function createLedger(
    store: Store,
    storyId: string,
    kind: LedgerKind,
    subject: string,
    detail?: string,
    chapterRef?: string,
    status: LedgerStatus = 'open'
): LedgerEntry {
    return store.ledger.create({ story_id: storyId, kind, subject, detail, chapter_ref: chapterRef, status }, WRITER);
}

function createVerdict(
    store: Store,
    storyId: string,
    targetRef: string,
    targetKind: string,
    lines: VerdictCriterion[]
): Verdict {
    return store.verdicts.create(
        {
            story_id: storyId,
            target_ref: targetRef,
            target_kind: targetKind,
            run_ref: CHECKER.run_ref ?? undefined,
            round: 1,
            criteria_passed: lines,
            hard_pass: lines.every((line) => line.result),
            soft_count: lines.filter((line) => line.result).length,
            recommendation: 'fix'
        },
        CHECKER
    );
}

function line(criterion: string, result: boolean, evidence: string, findingRef?: string): VerdictCriterion {
    return findingRef ? { criterion, result, evidence, finding_ref: findingRef } : { criterion, result, evidence };
}

function seedGoal(store: Store, storyId: string, thresholdSoft: number, criteria?: Criterion[]): void {
    const base = defaultGoal(storyId);

    store.goals.create(
        {
            story_id: storyId,
            title: base.title,
            threshold_soft: thresholdSoft,
            criteria: criteria ?? base.criteria,
            flat_rounds: base.flat_rounds,
            regress_tolerance: base.regress_tolerance
        },
        AUTHOR
    );
}

/** A code result, asserted whole — `source: 'code'` is part of the contract, not an implementation detail (G-3). */
function code(criterion: string, passed: boolean, evidence: string): CriterionResult {
    return { criterion, passed, evidence, source: 'code' };
}

/** Pulls one criterion out of an `evaluateCode` run by id. */
function only(results: CriterionResult[], criterion: string): CriterionResult {
    const found = results.find((result) => result.criterion === criterion);

    if (!found)
        throw new Error(
            `evaluateCode returned no result for ${criterion}: ${results.map((result) => result.criterion).join(', ')}`
        );

    return found;
}

describe('CriteriaEngine — the code half runs with no model (G-3, D-10)', () => {
    let store: Store;
    let engine: CriteriaEngine;

    beforeEach(() => {
        store = Store.empty();
        engine = new CriteriaEngine();
    });

    it('imports nothing that can reach a model, so every code criterion is decided server-side (G-3)', () => {
        // BY CONSTRUCTION: the module's whole import surface is the data model, the Goal roster, and
        // the store's TYPES. Anything model-shaped (the llm client, a fetch call, a reactive signal)
        // would have to arrive through an import, and this assertion fails the moment it does.
        // `import.meta.dirname`, not `new URL('./engine.ts', import.meta.url)`: Vite rewrites that
        // exact pattern into an asset URL, which is not a path on disk.
        const source = readFileSync(`${import.meta.dirname}/engine.ts`, 'utf8');
        const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

        expect(specifiers).toEqual(['../../shared/types', '../../shared/criteria', '../store']);
        expect(source).toContain('import type { Store }');
        expect(source).not.toMatch(/\bfetch\(/);
        expect(source).not.toMatch(/\bawait\b/);
    });

    it('answers exactly C-0, C-1, C-5, C-6 and C-15 from an empty store, every one with source `code`', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 0);

        const results = engine.evaluateCode(store, story.id);

        expect(results.map((result) => result.criterion)).toEqual(['C-0', 'C-1', 'C-5', 'C-6', 'C-15']);
        expect(results.every((result) => result.source === 'code')).toBe(true);
        expect(results.every((result) => result.passed)).toBe(true);
        expect(only(results, 'C-1')).toEqual(
            code(
                'C-1',
                true,
                'no chapter exists yet, so C-1 has no orphan to find — it re-checks per chapter in phase 3'
            )
        );
        expect(only(results, 'C-5')).toEqual(
            code('C-5', true, '0 setup and 0 payoff entries pair off on their normalised subjects — no open thread')
        );
        expect(only(results, 'C-6')).toEqual(
            code(
                'C-6',
                true,
                '0 anchored timeline entries in non-decreasing chapter order and no fact key with two readings'
            )
        );
        expect(only(results, 'C-15')).toEqual(
            code('C-15', true, 'no Idea is `selected`, so nothing unverified has reached an artifact (D-29)')
        );
    });

    // -- C-0 (D-3b, L-6a) ----------------------------------------------------------------------

    it('fails C-0 when 7 plotlines face a declared chapter_count of 8, naming both numbers', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 8);

        for (let order = 1; order <= 7; order += 1) createPlotline(store, story.id, order);

        expect(only(engine.evaluateCode(store, story.id), 'C-0')).toEqual(
            code(
                'C-0',
                false,
                '7 plotlines exist for a declared chapter_count of 8 — no more, no fewer: create the missing one(s) (D-3b, L-6a)'
            )
        );
    });

    it('fails C-0 when 9 plotlines face a declared chapter_count of 8 — the surplus is named too (L-6a)', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 8);

        for (let order = 1; order <= 9; order += 1) createPlotline(store, story.id, order);

        expect(only(engine.evaluateCode(store, story.id), 'C-0')).toEqual(
            code(
                'C-0',
                false,
                '9 plotlines exist for a declared chapter_count of 8 — no more, no fewer: delete the surplus (D-3b, L-6a)'
            )
        );
    });

    it('passes C-0 only when the chapters match too, and names both counts (D-3b, L-6a)', () => {
        const story = createStory(store, 'chapters');
        createSummary(store, story.id, 2);
        const first = createPlotline(store, story.id, 1);
        const second = createPlotline(store, story.id, 2);
        createChapter(store, story.id, 1, first.id);
        createChapter(store, story.id, 2, second.id);

        expect(only(engine.evaluateCode(store, story.id), 'C-0')).toEqual(
            code('C-0', true, '2 plotlines and 2 chapters for a declared chapter_count of 2 — no more, no fewer')
        );
    });

    it('fails C-0 when 7 chapters face a declared chapter_count of 8, plotlines and all (U-1b, review fix 4)', () => {
        // The case the old checker waved through: §5.2's C-0 asks for "exactly `chapter_count`
        // chapters", and a completion prompt that quotes a passing C-0 over a short book is the product
        // lying to the Author (L-6a: the count is Author truth, so 7-of-8 is a failure, not a rounding).
        const story = createStory(store, 'chapters');
        createSummary(store, story.id, 8);

        for (let order = 1; order <= 8; order += 1) createPlotline(store, story.id, order);

        for (let order = 1; order <= 7; order += 1) createChapter(store, story.id, order);

        expect(only(engine.evaluateCode(store, story.id), 'C-0')).toEqual(
            code(
                'C-0',
                false,
                '8 plotlines match the declared chapter_count of 8, but only 7 chapters are drafted — no more, no fewer: write the missing 1 (D-3b, L-6a)'
            )
        );
    });

    it('fails C-0 on a chapter surplus too, and says who may change the number (L-6a, D-3b)', () => {
        const story = createStory(store, 'chapters');
        createSummary(store, story.id, 1);
        createPlotline(store, story.id, 1);
        createChapter(store, story.id, 1);
        createChapter(store, story.id, 2);

        expect(only(engine.evaluateCode(store, story.id), 'C-0')).toEqual(
            code(
                'C-0',
                false,
                "1 plotline matches the declared chapter_count of 1, but 2 chapters are drafted — no more, no fewer: the surplus is the Author's to re-declare, not the crew's to ignore (D-3b, L-6a)"
            )
        );
    });

    it('keeps C-0 vacuous at zero chapters, because phase 2 has not been asked to write any (L-14)', () => {
        // The half that stays `n/a`: failing a plotline-phase Story for having no chapters is the
        // `0/n`-vs-`n/a` confusion L-14 forbids, and it is why the chapter check is guarded by
        // `chapters.length > 0` rather than running unconditionally.
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 2);
        createPlotline(store, story.id, 1);
        createPlotline(store, story.id, 2);

        expect(only(engine.evaluateCode(store, story.id), 'C-0')).toEqual(
            code('C-0', true, '2 plotlines and 0 chapters for a declared chapter_count of 2 — no more, no fewer')
        );
    });

    it('fails C-0 rather than guessing when no Summary declares chapter_count (D-3b)', () => {
        const story = createStory(store, 'plotlines');
        createPlotline(store, story.id, 1);

        expect(only(engine.evaluateCode(store, story.id), 'C-0')).toEqual(
            code(
                'C-0',
                false,
                `no Summary record exists for ${story.id}, so chapter_count is undeclared and C-0 has nothing to count against (D-3b)`
            )
        );
    });

    // -- C-1 (P4) ------------------------------------------------------------------------------

    it('fails C-1 naming every chapter with a missing or dangling plotline_ref (P4)', () => {
        const story = createStory(store, 'chapters');
        createSummary(store, story.id, 2);
        const bound = createPlotline(store, story.id, 1);
        createChapter(store, story.id, 1);
        createChapter(store, story.id, 2, 'plotline_9');

        expect(only(engine.evaluateCode(store, story.id), 'C-1')).toEqual(
            code(
                'C-1',
                false,
                '2 of 2 chapters have no resolvable plotline: chapter_1 (order 1, no plotline_ref); chapter_2 (order 2, plotline_ref plotline_9 is missing)'
            )
        );
        expect(bound.order).toBe(1);
    });

    it('passes C-1 when every chapter names a plotline that exists', () => {
        const story = createStory(store, 'chapters');
        createSummary(store, story.id, 2);
        const first = createPlotline(store, story.id, 1);
        const second = createPlotline(store, story.id, 2);
        createChapter(store, story.id, 1, first.id);
        createChapter(store, story.id, 2, second.id);

        expect(only(engine.evaluateCode(store, story.id), 'C-1')).toEqual(
            code('C-1', true, 'all 2 chapters name a plotline that exists')
        );
    });

    // -- C-5 (D-10) ----------------------------------------------------------------------------

    it('fails C-5 naming the setup that has no payoff (D-10)', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 1);
        createLedger(store, story.id, 'setup', 'The Pistol');

        expect(only(engine.evaluateCode(store, story.id), 'C-5')).toEqual(
            code('C-5', false, 'setup with no payoff: "The Pistol"')
        );
    });

    it('fails C-5 naming the payoff with no setup — a rescue nobody earned is the same break (D-10)', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 1);
        createLedger(store, story.id, 'payoff', 'the pistol fires');

        expect(only(engine.evaluateCode(store, story.id), 'C-5')).toEqual(
            code('C-5', false, 'payoff with no setup: "the pistol fires"')
        );
    });

    it('passes C-5 when the pair matches on a normalised subject — case and padding are not facts (D-10)', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 2);
        const first = createChapter(store, story.id, 1);
        createLedger(store, story.id, 'setup', '  The   Pistol ', 'loaded and wrapped in oilcloth', first.id);
        createLedger(store, story.id, 'payoff', 'the pistol', 'it fires in the mill', first.id);

        expect(only(engine.evaluateCode(store, story.id), 'C-5')).toEqual(
            code('C-5', true, '1 setup and 1 payoff entries pair off on their normalised subjects — no open thread')
        );
    });

    it('ignores stale ledger entries in both directions — a retired promise is not outstanding (D-10)', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 1);
        createLedger(store, story.id, 'setup', 'The Mentor Knows', undefined, undefined, 'stale');

        expect(only(engine.evaluateCode(store, story.id), 'C-5')).toEqual(
            code('C-5', true, '0 setup and 0 payoff entries pair off on their normalised subjects — no open thread')
        );
    });

    // -- C-6 (D-10) ----------------------------------------------------------------------------

    it('passes C-6 when the anchored timeline runs forward with the chapters', () => {
        const story = createStory(store, 'chapters');
        createSummary(store, story.id, 2);
        const chapterOne = createChapter(store, story.id, 1);
        const chapterTwo = createChapter(store, story.id, 2);
        createLedger(store, story.id, 'timeline', 'the flood', 'day 3', chapterOne.id);
        createLedger(store, story.id, 'timeline', 'the rescue', 'day 5', chapterTwo.id);

        expect(only(engine.evaluateCode(store, story.id), 'C-6')).toEqual(
            code(
                'C-6',
                true,
                '2 anchored timeline entries in non-decreasing chapter order and no fact key with two readings'
            )
        );
    });

    it('fails C-6 when the timeline goes backwards, naming the two entries (D-10)', () => {
        const story = createStory(store, 'chapters');
        createSummary(store, story.id, 2);
        const chapterOne = createChapter(store, story.id, 1);
        const chapterTwo = createChapter(store, story.id, 2);
        createLedger(store, story.id, 'timeline', 'the flood', 'day 5', chapterTwo.id);
        createLedger(store, story.id, 'timeline', 'the rescue', 'day 3', chapterOne.id);

        expect(only(engine.evaluateCode(store, story.id), 'C-6')).toEqual(
            code(
                'C-6',
                false,
                'timeline goes backwards: ledger_entry_2 ("the rescue", chapter chapter_1 order 1) is recorded after ledger_entry_1 (chapter order 2)'
            )
        );
    });

    it('fails C-6 on a fact contradiction sharing a subject, quoting both readings (D-10)', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 1);
        createLedger(store, story.id, 'fact', 'vera age', 'Vera is 37');
        createLedger(store, story.id, 'fact', 'Vera  Age', 'Vera is 42');

        expect(only(engine.evaluateCode(store, story.id), 'C-6')).toEqual(
            code(
                'C-6',
                false,
                'fact contradiction on "vera age": ledger_entry_1 says "vera is 37" vs ledger_entry_2 says "vera is 42"'
            )
        );
    });

    it('passes C-6 when two facts share a subject and agree on the detail', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 1);
        createLedger(store, story.id, 'fact', 'vera age', ' Vera is 37 ');
        createLedger(store, story.id, 'fact', 'vera age', 'vera is 37');

        expect(only(engine.evaluateCode(store, story.id), 'C-6')).toEqual(
            code(
                'C-6',
                true,
                '0 anchored timeline entries in non-decreasing chapter order and no fact key with two readings'
            )
        );
    });

    it('reports an unanchored timeline entry in the evidence instead of silently skipping it', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 1);
        createLedger(store, story.id, 'timeline', 'the flood', 'day 3');

        expect(only(engine.evaluateCode(store, story.id), 'C-6')).toEqual(
            code(
                'C-6',
                true,
                '0 anchored timeline entries in non-decreasing chapter order and no fact key with two readings; 1 timeline entry(ies) carry no resolvable chapter_ref and were not ordered'
            )
        );
    });

    it('never writes while evaluating: C-6 names the contradiction, the loop marks it (D-10, P11)', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 1);
        createLedger(store, story.id, 'fact', 'vera age', 'Vera is 37');
        createLedger(store, story.id, 'fact', 'vera age', 'Vera is 42');

        const before = store.ledger.list();
        const events = store.journal.length;

        engine.evaluateCode(store, story.id);

        expect(store.ledger.list()).toEqual(before);
        expect(store.journal.length).toBe(events);
        expect(before.map((entry) => entry.status)).toEqual(['open', 'open']);
    });

    // -- C-15 (D-27, T-10) ---------------------------------------------------------------------

    it('fails C-15 when a sourced Idea is selected with no Editor verification (D-27)', () => {
        const story = createStory(store, 'summary');
        createSummary(store, story.id, 0);
        store.ideas.create(selectedIdea(store, { state: 'selected' }), AUTHOR);

        expect(only(engine.evaluateCode(store, story.id), 'C-15')).toEqual(
            code(
                'C-15',
                false,
                '1 selected Idea reached an artifact without a checked Editor verdict — idea_1 (1 source): no Editor verification at all'
            )
        );
    });

    it('passes C-15 when the selected Idea carries a verified verdict, evidence, and the checking run (D-31)', () => {
        const story = createStory(store, 'summary');
        createSummary(store, story.id, 0);
        store.ideas.create(
            selectedIdea(store, {
                state: 'selected',
                verification: {
                    verdict: 'verified',
                    evidence: 'p. 41 of the county record states the valley was flooded in 1953',
                    meets_guidelines: true,
                    checked_by_run: 'run_3',
                    checked_at: '2026-01-04T00:00:00.000Z'
                }
            }),
            AUTHOR
        );

        expect(only(engine.evaluateCode(store, story.id), 'C-15')).toEqual(
            code(
                'C-15',
                true,
                '1 selected Idea all carry a verified Editor verdict with evidence and a checking run (D-27)'
            )
        );
    });

    it('fails C-15 when the Editor verified but recorded no evidence line (D-15, T-10)', () => {
        const story = createStory(store, 'summary');
        createSummary(store, story.id, 0);
        store.ideas.create(
            selectedIdea(store, {
                state: 'selected',
                verification: {
                    verdict: 'verified',
                    evidence: '   ',
                    meets_guidelines: true,
                    checked_by_run: 'run_3',
                    checked_at: '2026-01-04T00:00:00.000Z'
                }
            }),
            AUTHOR
        );

        expect(only(engine.evaluateCode(store, story.id), 'C-15')).toEqual(
            code(
                'C-15',
                false,
                '1 selected Idea reached an artifact without a checked Editor verdict — idea_1 (1 source): the verdict carries no evidence line (D-15)'
            )
        );
    });

    it('fails C-15 when a refuted Idea was selected anyway — a refutation is not a pass (T-10)', () => {
        const story = createStory(store, 'summary');
        createSummary(store, story.id, 0);
        store.ideas.create(
            selectedIdea(store, {
                state: 'selected',
                verification: {
                    verdict: 'refuted',
                    evidence: 'the page does not say that',
                    meets_guidelines: true,
                    checked_by_run: 'run_3',
                    checked_at: '2026-01-04T00:00:00.000Z'
                }
            }),
            AUTHOR
        );

        expect(only(engine.evaluateCode(store, story.id), 'C-15')).toEqual(
            code(
                'C-15',
                false,
                '1 selected Idea reached an artifact without a checked Editor verdict — idea_1 (1 source): the Editor verdict is `refuted`'
            )
        );
    });
});

// ---------------------------------------------------------------------------
// Judge aggregation (§4.9, D-15) — the engine collects, the crew answers
// ---------------------------------------------------------------------------

describe('CriteriaEngine — judge criteria aggregate from verdicts (D-15)', () => {
    let store: Store;
    let engine: CriteriaEngine;
    let story: Story;

    beforeEach(() => {
        store = Store.empty();
        engine = new CriteriaEngine();
        story = createStory(store, 'plotlines');
        createSummary(store, story.id, 1);
    });

    it('lets the latest verdict decide: an older failure does not survive a newer pass', () => {
        const plotline = createPlotline(store, story.id, 1);

        // Created first, judged false; the newer verdict that clears it must win, or a chapter that
        // was fixed would stay failed forever and the loop would grind (L-15's trend needs the same
        // "what is true NOW" reading).
        createVerdict(store, story.id, plotline.id, 'plotline', [
            line('C-2', false, 'it contradicts the declared ending')
        ]);
        createVerdict(store, story.id, plotline.id, 'plotline', [
            line('C-2', true, 'rewritten: it now traces to the ending')
        ]);

        expect(engine.aggregateJudge(store, story.id, ['C-2'])).toEqual([
            {
                criterion: 'C-2',
                passed: true,
                evidence: 'the latest verdict for each of 1 target(s) passes C-2',
                source: 'verdict'
            }
        ]);
    });

    it('flips to failing when the newest verdict fails, carrying its evidence and finding (D-15, D-16)', () => {
        const plotline = createPlotline(store, story.id, 1);

        createVerdict(store, story.id, plotline.id, 'plotline', [line('C-2', true, 'clean in the earlier draft')]);
        createVerdict(store, story.id, plotline.id, 'plotline', [
            line('C-2', false, 'the new ending contradicts the promise', 'finding_1')
        ]);

        expect(engine.aggregateJudge(store, story.id, ['C-2'])).toEqual([
            {
                criterion: 'C-2',
                passed: false,
                evidence: `${plotline.id}: the new ending contradicts the promise`,
                finding_ref: 'finding_1',
                source: 'verdict'
            }
        ]);
    });

    it('breaks a same-millisecond tie deterministically, because a flaky criterion makes the trend flaky (L-15)', () => {
        const plotline = createPlotline(store, story.id, 1);

        createVerdict(store, story.id, plotline.id, 'plotline', [line('C-2', false, 'first report')]);
        createVerdict(store, story.id, plotline.id, 'plotline', [line('C-2', true, 'second report')]);

        // Both rows carry the same `created_at` in a fast test, so `verdict_2` wins on the documented
        // rev-then-id tie-break; the next assertion shows `created_at` outranks that ordering.
        expect(engine.aggregateJudge(store, story.id, ['C-2'])[0].passed).toBe(true);

        vi.useFakeTimers();

        try {
            vi.setSystemTime(new Date('2026-01-05T12:00:00.000Z'));

            const older = createVerdict(store, story.id, plotline.id, 'plotline', [
                line('C-2', true, 'created last, timestamped earliest')
            ]);

            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

            createVerdict(store, story.id, plotline.id, 'plotline', [
                line('C-2', false, 'timestamped before every other verdict')
            ]);

            expect(engine.aggregateJudge(store, story.id, ['C-2'])).toEqual([
                {
                    criterion: 'C-2',
                    passed: true,
                    evidence: 'the latest verdict for each of 1 target(s) passes C-2',
                    source: 'verdict'
                }
            ]);
            expect(older.target_ref).toBe(plotline.id);
        } finally {
            vi.useRealTimers();
        }
    });

    it('fails with `no verdict yet` when any in-scope target has never been judged (P6)', () => {
        createPlotline(store, story.id, 1);
        const second = createPlotline(store, story.id, 2);

        createVerdict(store, story.id, second.id, 'plotline', [line('C-2', true, 'this one traces to the Summary')]);

        expect(engine.aggregateJudge(store, story.id, ['C-2'])).toEqual([
            { criterion: 'C-2', passed: false, evidence: 'plotline_1: no verdict yet', source: 'verdict' }
        ]);
    });

    it('fails a judge criterion with no artifacts at all rather than passing it vacuously', () => {
        // A criterion nobody has judged is not a criterion that passed: P6's boolean needs a citation.
        expect(engine.aggregateJudge(store, story.id, ['C-2'])).toEqual([
            {
                criterion: 'C-2',
                passed: false,
                evidence: `no artifact exists for ${story.id} at this criterion's level, so C-2 has no verdict yet — nothing has been judged`,
                source: 'verdict'
            }
        ]);
    });

    it('judges C-4 against the Story record, because that is the only id naming the plotline set', () => {
        createPlotline(store, story.id, 1);
        createPlotline(store, story.id, 2);

        createVerdict(store, story.id, story.id, 'story', [
            line('C-4', true, 'no adjacent contradiction across the eight beats')
        ]);

        expect(engine.aggregateJudge(store, story.id, ['C-4'])).toEqual([
            {
                criterion: 'C-4',
                passed: true,
                evidence: 'the latest verdict for each of 1 target(s) passes C-4',
                source: 'verdict'
            }
        ]);

        // A verdict aimed at one plotline cannot answer the cross-set question.
        createVerdict(store, story.id, 'plotline_1', 'plotline', [
            line('C-4', true, 'this plotline is fine on its own')
        ]);

        expect(engine.aggregateJudge(store, story.id, ['C-4'])).toEqual([
            {
                criterion: 'C-4',
                passed: true,
                evidence: 'the latest verdict for each of 1 target(s) passes C-4',
                source: 'verdict'
            }
        ]);
    });

    it('is not answered by a verdict against a competing DRAFT — the Goal reads artifact targets only (§6.2a, D-21, D-22)', () => {
        const chapter = createChapter(store, story.id, 1);

        // The unit-level report says the chapter fails C-7. A checker pointed at one draft (§6.2a's loop
        // B) files against `revision_N`, and that judgement is about a PROSE ALTERNATIVE, not the stored
        // artifact. If a draft verdict could satisfy the criterion, the loop would read the Goal as
        // passing off the strength of a draft that D-22 deletes one commit later.
        createVerdict(store, story.id, chapter.id, 'chapter', [
            line('C-7', false, 'the chapter never delivers the plotline contract')
        ]);

        expect(engine.aggregateJudge(store, story.id, ['C-7'])).toEqual([
            {
                criterion: 'C-7',
                passed: false,
                evidence: `${chapter.id}: the chapter never delivers the plotline contract`,
                source: 'verdict'
            }
        ]);

        // The draft verdict is NEWER and passes, and it changes nothing: `scopeTargets` for a
        // chapter-level criterion yields chapter ids (engine.ts:scopeTargets), so a `revision_N` target
        // is never consulted. This is the guard the U-13 per-draft verdicts rely on — showing a draft's
        // verdict to the Author must not move the Goal.
        createVerdict(store, story.id, 'revision_1', 'revision', [
            line('C-7', true, 'this draft delivers the contract')
        ]);

        expect(engine.aggregateJudge(store, story.id, ['C-7'])).toEqual([
            {
                criterion: 'C-7',
                passed: false,
                evidence: `${chapter.id}: the chapter never delivers the plotline contract`,
                source: 'verdict'
            }
        ]);

        // And the reverse: a draft verdict with no artifact verdict leaves the criterion unanswered —
        // "a draft was judged" is not "the artifact was judged" (P6).
        const second = createChapter(store, story.id, 2);

        expect(engine.aggregateJudge(store, story.id, ['C-7'])[0]).toEqual({
            criterion: 'C-7',
            passed: false,
            evidence: `${chapter.id}: the chapter never delivers the plotline contract · ${second.id}: no verdict yet`,
            source: 'verdict'
        });
    });

    it('judges C-14 against the Summary record and C-10/C-13 against the Story', () => {
        createVerdict(store, story.id, 'summary_1', 'summary', [
            line('C-14', true, 'the Summary carries every central beat of the Seed')
        ]);
        createVerdict(store, story.id, story.id, 'story', [
            line('C-10', true, 'the ending pays the promise'),
            line('C-13', true, 'the prose matches the tone sheet')
        ]);

        expect(engine.aggregateJudge(store, story.id, ['C-14', 'C-10', 'C-13']).map((result) => result.passed)).toEqual(
            [true, true, true]
        );
    });

    it('falls back to the linked finding when the verdict line carries no evidence (D-15)', () => {
        const plotline = createPlotline(store, story.id, 1);

        store.findings.create(
            {
                story_id: story.id,
                target_ref: plotline.id,
                criterion_ref: 'C-3',
                title: 'must_change restates must_happen',
                evidence: 'both fields name the burned map',
                cost: 'minor',
                fingerprint: 'fp_c3',
                state: 'confirmed',
                seen_count: 1
            },
            CHECKER
        );
        createVerdict(store, story.id, plotline.id, 'plotline', [line('C-3', false, '', 'finding_1')]);

        expect(engine.aggregateJudge(store, story.id, ['C-3'])).toEqual([
            {
                criterion: 'C-3',
                passed: false,
                evidence: 'plotline_1: finding_1: both fields name the burned map',
                finding_ref: 'finding_1',
                source: 'verdict'
            }
        ]);
    });

    it("ignores another Story's verdicts — one run, one Story (T-3)", () => {
        const other = createStory(store, 'plotlines');
        const plotline = createPlotline(store, story.id, 1);

        createVerdict(store, other.id, plotline.id, 'plotline', [line('C-2', true, 'this belongs to the other story')]);

        expect(engine.aggregateJudge(store, story.id, ['C-2'])[0].evidence).toBe(`${plotline.id}: no verdict yet`);
    });
});

// ---------------------------------------------------------------------------
// Levels and progress (§5.2, L-14, G-2)
// ---------------------------------------------------------------------------

describe('CriteriaEngine — levels and per-phase progress (L-14, G-2)', () => {
    let store: Store;
    let engine: CriteriaEngine;

    beforeEach(() => {
        store = Store.empty();
        engine = new CriteriaEngine();
    });

    it('reports the levels a Phase 1 Story has not reached as `n/a`, never `0/2` or `0/3` (L-14)', () => {
        const story = createStory(store, 'summary');
        createSummary(store, story.id, 8);

        expect(engine.levelStatus(store, story)).toEqual({
            levels: { summary: { passed: 1, total: 2 }, plotlines: 'n/a', chapters: 'n/a', whole: 'n/a' },
            failing: ['C-14']
        });
    });

    it('reports every reached level and collects the failures in level order', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 8);

        for (let order = 1; order <= 7; order += 1) createPlotline(store, story.id, order);

        expect(engine.levelStatus(store, story)).toEqual({
            levels: {
                summary: { passed: 1, total: 2 },
                plotlines: { passed: 3, total: 7 },
                chapters: 'n/a',
                whole: 'n/a'
            },
            failing: ['C-14', 'C-0', 'C-2', 'C-3', 'C-4']
        });
    });

    it('renders the phase Goal as `n/m · failing: …` for the CURRENT phase only (W3, G-2)', () => {
        const story = createStory(store, 'plotlines');
        createSummary(store, story.id, 8);

        for (let order = 1; order <= 7; order += 1) createPlotline(store, story.id, order);

        // C-1/C-5/C-6 pass; C-0 fails on the count; C-2/C-3/C-4 have no verdicts. The chapter and
        // whole-Story criteria (C-7…C-13) are NOT in the string — that is G-2's rule.
        const status = engine.phaseGoalStatus(store, story);

        expect(status.progress).toBe('3/7 · failing: C-0, C-2, C-3, C-4');
        expect(status.passed).toBe(false);
        expect(status.softPassed).toBe(0);
        expect(status.softThreshold).toBe(1);
    });

    it('shows a Phase 1 Story only its own two criteria, so a later phase never reads as failing (G-2)', () => {
        const story = createStory(store, 'summary');
        createSummary(store, story.id, 8);

        const status = engine.phaseGoalStatus(store, story);

        expect(status.progress).toBe('1/2 · failing: C-14');
        expect(status.failing).toEqual([
            {
                criterion: 'C-14',
                fix_hint:
                    'Expand the Summary to carry everything central to the Seed, and remove what contradicts it (P5: the Seed is never edited to pass).',
                evidence: 'summary_1: no verdict yet'
            }
        ]);
        expect(status.progress).not.toContain('C-0');
    });

    it('passes the phase Goal when every hard criterion passes and the soft bar is met', () => {
        const story = awaitChapterThree(store);

        // C-7/C-8 per chapter, C-10/C-11/C-13 against the Story: the whole phase-3 set is 6 criteria.
        createVerdict(store, story.id, 'chapter_1', 'chapter', [
            line('C-7', true, 'every named event is on the page'),
            line('C-8', true, 'the change lands in the last section'),
            line('C-9', true, 'no behaviour against the arc')
        ]);
        createVerdict(store, story.id, 'chapter_2', 'chapter', [
            line('C-7', true, 'every named event is on the page'),
            line('C-8', true, 'the change lands in the last section'),
            line('C-9', true, 'no behaviour against the arc')
        ]);
        createVerdict(store, story.id, story.id, 'story', [
            line('C-10', true, 'the ending pays the promise'),
            line('C-11', true, 'no two chapters do the same job'),
            line('C-13', true, "the prose reads as the Author's")
        ]);

        const status = engine.phaseGoalStatus(store, story);

        expect(status.progress).toBe('6/6');
        expect(status.passed).toBe(true);
        expect(status.softPassed).toBe(2);
        expect(status.softThreshold).toBe(2);
        expect(status.failing).toEqual([]);
    });

    it('blocks the Goal on a soft shortfall while every HARD criterion passes (§5.1, L-28)', () => {
        const story = awaitChapterThree(store);

        createVerdict(store, story.id, 'chapter_1', 'chapter', [
            line('C-7', true, 'events delivered'),
            line('C-8', true, 'change delivered'),
            line('C-9', false, 'Vera acts against her arc with no scene owning it', 'finding_2')
        ]);
        createVerdict(store, story.id, 'chapter_2', 'chapter', [
            line('C-7', true, 'events delivered'),
            line('C-8', true, 'change delivered'),
            line('C-9', false, 'Vera acts against her arc with no scene owning it', 'finding_2')
        ]);
        createVerdict(store, story.id, story.id, 'story', [
            line('C-10', true, 'the ending pays the promise'),
            line('C-11', true, 'no two chapters do the same job'),
            line('C-13', true, "the prose reads as the Author's")
        ]);

        const status = engine.phaseGoalStatus(store, story);

        expect(status.progress).toBe('5/6 · failing: C-9');
        expect(status.softPassed).toBe(1);
        // Default threshold 3 capped to the two soft criteria in this level — see `tally`'s note: a
        // literal `≥ 3` would be unreachable here and would stall the sign-off (L-6) forever.
        expect(status.softThreshold).toBe(2);
        expect(status.passed).toBe(false);
        expect(status.failing).toEqual([
            {
                criterion: 'C-9',
                fix_hint: 'Add the scene that owns the change, or bring the behaviour back to the cast record (D-9).',
                evidence: `chapter_1: Vera acts against her arc with no scene owning it · chapter_2: Vera acts against her arc with no scene owning it`
            }
        ]);
    });

    it('evaluates the built-in Goal when the Story names none, and does not write one (G-1, P10)', () => {
        const story = createStory(store, 'summary');
        createSummary(store, story.id, 4);

        const status = engine.phaseGoalStatus(store, story);

        expect(store.goals.count()).toBe(0);
        expect(engine.resolveGoal(store, story).criteria.map((criterion) => criterion.id)).toEqual(
            defaultGoal(story.id).criteria.map((criterion) => criterion.id)
        );
        expect(status.progress).toBe('1/2 · failing: C-14');
    });

    it('honours a Goal row the Author edited: a deleted criterion leaves the count (G-1)', () => {
        const story = createStory(store, 'summary');
        createSummary(store, story.id, 4);
        const criteria = defaultGoal(story.id).criteria.filter((criterion) => criterion.id !== 'C-14');

        seedGoal(store, story.id, 3, criteria);

        expect(engine.phaseGoalStatus(store, story).progress).toBe('1/1');
    });

    it('fails an Author-added code criterion naming that no checker implements it (G-3, G-6)', () => {
        const story = createStory(store, 'summary');
        createSummary(store, story.id, 4);
        const custom: Criterion = {
            id: 'C-20',
            label: 'no chapter opens with weather',
            question: 'Does any chapter open with weather?',
            checker: 'code',
            hard: true,
            fix_hint: 'open the chapter with an action instead'
        };

        seedGoal(store, story.id, 3, defaultGoal(story.id).criteria.concat([custom]));

        const status = engine.phaseGoalStatus(store, story);

        // An unplaced criterion falls to the whole-Story level (§5.2 gives it no home), so it surfaces
        // in phase 3 rather than vanishing from the Goal.
        expect(status.progress).toBe('1/2 · failing: C-14');
        expect(engine.levelStatus(store, { ...story, phase: 'chapters' }).levels.whole).toEqual({
            passed: 0,
            total: 4
        });
        expect(engine.levelStatus(store, { ...story, phase: 'chapters' }).failing).toContain('C-20');
    });
});

// ---------------------------------------------------------------------------
// The per-chapter bar (§4.4 `bar_override`, G-1, §14 item 2)
// ---------------------------------------------------------------------------

describe('CriteriaEngine — the per-chapter Goal and `bar_override` (G-1)', () => {
    let store: Store;
    let engine: CriteriaEngine;
    let story: Story;
    let chapter: Chapter;

    beforeEach(() => {
        store = Store.empty();
        engine = new CriteriaEngine();
        story = createStory(store, 'chapters');
        createSummary(store, story.id, 1);
        const plotline = createPlotline(store, story.id, 1);
        chapter = createChapter(store, story.id, 1, plotline.id);

        // C-9 fails, everything else in the chapter's set passes.
        createVerdict(store, story.id, chapter.id, 'chapter', [
            line('C-7', true, 'events delivered'),
            line('C-8', true, 'change delivered'),
            line('C-9', false, 'Vera acts against her arc'),
            line('C-12', true, 'the prose meets the tone sheet')
        ]);
    });

    it('judges the chapter level plus per-chapter C-12, against THIS chapter alone (§5.2)', () => {
        const status = engine.chapterGoalStatus(store, story, chapter.id);

        expect(status.progress).toBe('3/4 · failing: C-9');
        expect(status.softPassed).toBe(1);
        expect(status.softThreshold).toBe(2);
        expect(status.passed).toBe(false);
        expect(status.warnings).toEqual([]);
    });

    it('scopes the verdicts to the chapter under review, not the chapter set (T-3)', () => {
        const secondPlotline = createPlotline(store, story.id, 2);
        const second = createChapter(store, story.id, 2, secondPlotline.id);

        createVerdict(store, story.id, second.id, 'chapter', [
            line('C-7', false, 'the promised confrontation never happens'),
            line('C-8', false, 'nothing is different at the end'),
            line('C-9', true, 'behaviour holds'),
            line('C-12', true, 'the prose meets the tone sheet')
        ]);

        const good = engine.chapterGoalStatus(store, story, chapter.id);

        expect(good.progress).toBe('3/4 · failing: C-9');
        expect(engine.chapterGoalStatus(store, story, second.id).progress).toBe('2/4 · failing: C-7, C-8');
    });

    it('drops the criterion the override names, so a chapter can be held to a different bar (G-1)', () => {
        store.chapters.update(chapter.id, { bar_override: '-C-9' }, AUTHOR, [{ id: chapter.id, rev: chapter.rev }]);

        const status = engine.chapterGoalStatus(store, story, chapter.id);

        expect(status.progress).toBe('3/3');
        expect(status.softThreshold).toBe(1);
        expect(status.passed).toBe(true);
        expect(status.warnings).toEqual([]);
    });

    it('applies a `+1` threshold delta, so the ending can be held higher than chapter 3', () => {
        const criteria = defaultGoal(story.id).criteria;

        seedGoal(store, story.id, 1, criteria);

        const relaxed = engine.chapterGoalStatus(store, story, chapter.id);

        expect(relaxed.passed).toBe(true);
        expect(relaxed.softPassed).toBe(1);
        expect(relaxed.softThreshold).toBe(1);

        store.chapters.update(chapter.id, { bar_override: '+1' }, AUTHOR, [{ id: chapter.id, rev: chapter.rev }]);

        const raised = engine.chapterGoalStatus(store, story, chapter.id);

        expect(raised.passed).toBe(false);
        expect(raised.softPassed).toBe(1);
        expect(raised.softThreshold).toBe(2);
        expect(raised.progress).toBe('3/4 · failing: C-9');
    });

    it('ignores an unparseable token and says so instead of silently changing the bar (G-2)', () => {
        store.chapters.update(chapter.id, { bar_override: 'stricter -C-9' }, AUTHOR, [
            { id: chapter.id, rev: chapter.rev }
        ]);

        const status = engine.chapterGoalStatus(store, story, chapter.id);

        expect(status.warnings).toEqual([
            'ignoring unrecognised bar_override token "stricter" — expected -C-<id> or a ± threshold delta'
        ]);
        expect(status.progress).toBe('3/3');
    });

    it('warns when the override drops a criterion this chapter was never judged on', () => {
        store.chapters.update(chapter.id, { bar_override: '-C-3' }, AUTHOR, [{ id: chapter.id, rev: chapter.rev }]);

        const status = engine.chapterGoalStatus(store, story, chapter.id);

        expect(status.warnings).toEqual([
            "bar_override drops C-3, which this chapter's criteria do not contain — the token changed nothing"
        ]);
        expect(status.progress).toBe('3/4 · failing: C-9');
    });

    it('refuses a chapter that belongs to another Story (T-3)', () => {
        const other = createStory(store, 'chapters');

        expect(() => engine.chapterGoalStatus(store, other, chapter.id)).toThrow(
            'chapter chapter_1 belongs to story_1, not story_2 — T-3 scopes every read to one Story'
        );
        expect(() => engine.chapterGoalStatus(store, story, 'chapter_99')).toThrow(
            'no chapter named chapter_99 in the chapters collection — the per-chapter Goal has nothing to measure'
        );
    });
});

// ---------------------------------------------------------------------------
// Fixture helpers used by more than one block
// ---------------------------------------------------------------------------

/** A Story standing where Loop B stands: phase 3, two chapters against two plotlines, clean ledger. */
function awaitChapterThree(store: Store): Story {
    const story = createStory(store, 'chapters');

    createSummary(store, story.id, 2);

    const first = createPlotline(store, story.id, 1);
    const second = createPlotline(store, story.id, 2);

    createChapter(store, story.id, 1, first.id);
    createChapter(store, story.id, 2, second.id);

    return story;
}

/** §4.17's Idea payload: sourced unless a test says otherwise, since C-15 is about sourced Ideas. */
function selectedIdea(
    store: Store,
    overrides: Partial<Idea> & { state: Idea['state'] }
): Omit<Idea, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        story_id: store.stories.list()[0].id,
        phase: 'summary',
        body: 'The 1953 flood was real; the valley was flooded on purpose.',
        kind: 'fact',
        author: 'reader_distant',
        sources: [
            {
                url_or_title: 'County Water Board, p. 41',
                claim: 'the valley was flooded in 1953',
                accessed_at: '2026-01-03T00:00:00.000Z'
            }
        ],
        fingerprint: 'idea_fp_1',
        seen_count: 1,
        verification: null,
        ...overrides
    };
}
