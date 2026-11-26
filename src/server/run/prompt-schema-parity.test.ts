/**
 * Task D — the PARITY guardrail for the two TOOL-LESS structured seats: the `review_groups` Critic
 * (`run/phase1-prompt.ts:compileGroupReviewPrompt`) and the `score_sections` Reader
 * (`run/phase1-prompt.ts:compileSectionScorePrompt`), on BOTH phrase lanes.
 *
 * WHY THIS FILE EXISTS BESIDE `phase1-prompt.test.ts` and `phase1-prompt-plotlines.test.ts`: those two
 * files pin the BYTES of the compiled turns (the prompt hash is the audit key, §5), and
 * `phrase/revisions.test.ts` pins the answer validators. None of them joins the three layers together,
 * which is exactly how the two defects this guardrail watches for were shipped:
 *
 *   1. VOICE DRIFT — a structured seat is briefed with a TOOL-CARRYING crew copy. `item.templateRef`
 *      is a scheduling label (`loop/work.ts`'s pool pick, D-17d's divergence rows), and trusting it
 *      handed a `toolMode: 'none'` seat the `raiseFinding`/`submitVerdict`/`createTask`/`readLedger`
 *      copy, or `reader-consistency`'s "Your output is a verdict" (P6: the score seat may file
 *      NOTHING). `templates.ts` and `phase1-prompt.ts` are edited independently, so only a test that
 *      reads the catalogue AND compiles the turn can see the two disagree.
 *   2. FIELD DRIFT — the prompt asks the model for a field the answer schema does not carry (the run
 *      is refused by `llm/structured.ts`, which closes objects on `additionalProperties: false`), or
 *      the schema gains a REQUIRED field nobody tells the model to emit (the answer fails validation
 *      for a reason the prompt never named). `group_quotes` is the field where the two layers were
 *      last out of step, and `parseGroupReviewAnswer` still enforces its coverage rule on its own.
 *
 * WHAT IS PINNED, and how each pin can fail:
 *   - the exact SYSTEM turn of each seat (the built-in role copy the compiler is bound to, plus the
 *     output contract that names the schema CONSTANT, so the label and the transport agree);
 *   - the exact binding SENTENCES of each engine-owned instruction block (the sentences that carry the
 *     contract — not whole constants, which `phase1-prompt.test.ts` already pins byte for byte);
 *   - the ABSENCE of every tool verb, backticked or plain, from both turns of a tool-less seat, while
 *     the "You have no tools and exactly one turn." sentence stays (the seat is tool-less, not silent);
 *   - field-by-field parity, in both directions, between what the turn asks for and what the schema
 *     closes — including that the schema's REQUIRED `detail` is named by the screen on BOTH lanes
 *     (2026-11-27: it had been the one required field no turn named, which is drift of the second kind
 *     above, and the pins that recorded it as an absence became presence pins when the screens grew the
 *     clause);
 *   - the `group_quotes` coverage contract the review prompt PROMISES ("a group named without a quote
 *     is refused") shown to be what `parseGroupReviewAnswer` actually DOES, refusal sentence and all,
 *     and in Phrase ② shown to be ENGINE-OWNED (`CONTRACT_SCREEN_INSTRUCTION`), so an Author edit of
 *     the role copy cannot delete a rule the parse refuses on;
 *
 * EXACT VALUES: the pinned sentences were read off compiled prompts (probes under repo-root
 * `Temp/opencode/`), and every id, vector hash and role prompt below is derived from the store the
 * fixture built or from `BUILT_IN_TEMPLATES` itself — no hash and no uuid is copied out of a transcript.
 */
import { dataClone } from '@presource/core';
import { describe, expect, it } from 'vitest';

// The two compilers and the two schemas under parity, plus the answer validator whose promise the
// review prompt repeats.
import { compileGroupReviewPrompt, compileSectionScorePrompt } from './phase1-prompt';
import { GroupReviewSchema, GROUP_REVIEW_SCHEMA_NAME } from '../../shared/schemas/group-review';
import { SectionScoresSchema, SECTION_SCORES_SCHEMA_NAME } from '../../shared/schemas/section-scores';
import { parseGroupReviewAnswer } from '../phrase/revisions';
// The catalogue the seats bind their voice to (`phase1-prompt.ts:rolePromptOf` reads these rows).
import { BUILT_IN_TEMPLATES } from '../templates';
// Fixture plumbing: the phase-① group book, and the phase-② chapter book built on top of it.
import { Store } from '../store';
import { AUTHOR_ATTR, seedFinding, seedStory, seedTask } from './mock';
import { ensurePhraseCatalog, storyPhraseByKey } from '../phrase/catalog';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { groupCheckSeatKey } from '../phrase/exclusion';
import { cleanSelectionOf, stampCleanRevisions } from '../phrase/reviewed';
import {
    acceptPlotlineBrief,
    createPlotlineBrief,
    startPlotlinesPhrase
} from '../phrase/controllers/plotlines';
import { PHRASE_SUMMARY_KEY } from '../../shared/phrase';
import { recordUidAt } from '../store/persist';
import type { PhraseGroup, Story } from '../../shared/types';

// ---------------------------------------------------------------------------
// The vocabulary the guardrail is written in
// ---------------------------------------------------------------------------

/**
 * Every TOOL name a seat could be told to call. All eight are `server/tools` verbs a `toolMode:
 * 'none'` run cannot invoke, and each appears by name in at least one tool-carrying crew copy
 * (`templates.ts`'s `critic-*` angles and `reader-consistency`), so an assertion over this list is a
 * real leak detector rather than a search for a word nothing uses.
 */
const TOOL_VERBS = [
    'raiseFinding',
    'submitVerdict',
    'createTask',
    'readLedger',
    'readSummary',
    'searchWeb',
    'fetchPage',
    'proposeIdea'
] as const;

/**
 * The deep-review ANGLE crews — the voices a structured seat must never be briefed with. They are the
 * realistic hazard, not a straw man: Phrase ② rotates Critic angles as its review pool
 * (`loop/work.ts:phraseGroupCandidates`), and every one of these copies instructs a tool call.
 */
const DEEP_REVIEW_SLUGS = ['critic-genre', 'critic-plausibility', 'critic-audience', 'critic-mystery'] as const;

/** The tool-carrying Reader whose copy the score seat used to be handed (D-65 named that wiring). */
const TOOL_READER_SLUG = 'reader-consistency';

/**
 * One built-in's role prompt, read the way `run/phase1-prompt.ts:rolePromptOf` reads it (the row's
 * `prompt`, trimmed). It comes from `BUILT_IN_TEMPLATES` rather than from a copy in this file on
 * purpose: the pin is WHICH crew the compiler picks, and a second copy of the shipped text would let a
 * template edit and a slug change cancel each other out in the test while the seat silently swapped.
 */
const builtInRolePrompt = (slug: string, roleName: string): string => {
    const role = BUILT_IN_TEMPLATES.find((template) => template.name === slug)?.roles?.find(
        (candidate) => candidate.name === roleName
    );

    return (role?.prompt ?? '').trim();
};

/** The line every no-tool system turn ends with (`phase1-prompt.ts:outputContract`). */
const outputContract = (schemaName: string): string =>
    `Answer with ONE JSON object matching the \`${schemaName}\` schema. You have no tools and exactly one turn. No prose outside the JSON.`;

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

/** The installed phase-① Overview: one short, distinct text per group, quoted verbatim by the prompt. */
const GROUP_TEXTS: Record<string, string> = {
    premise: 'A return to a mapped valley that no longer matches the map.',
    promise: 'The map and the territory reconcile, at the price of the map.',
    theme: 'Memory against measurement.',
    tone: 'Plain, cold, third person limited.',
    ending: 'She floods the valley and keeps the map.'
};

/** The three chapter seeds Phrase ② resolves — the accepted brief's own words. */
const CHAPTER_SEEDS = [
    'The keeper reads the ledger and finds his own name.',
    'The bird agrees to speak, for a price.',
    'The lamp warns the last ship.'
];

/**
 * The SHIPPED catalogue, seeded verbatim. A stub role prompt would hide half of what this file guards:
 * the tool-verb assertions have to run over the copy a real run sends, and the "not a deep-review
 * angle" pin needs the angle rows to exist in the same store the compiler reads.
 */
function seedBuiltInCrews(store: Store): void {
    for (const template of BUILT_IN_TEMPLATES) store.templates.create(dataClone(template), AUTHOR_ATTR);
}

const groupOf = (groups: PhraseGroup[], key: string): PhraseGroup => groups.find((group) => group.key === key)!;

/**
 * A group-managed phase-① book in the state a `review_groups` seat is dispatched into: the five catalog
 * groups installed at number 1, one approved issue scoped to `premise` with its open fix task, and the
 * shipped crews. Ids are the store's own (`recordUidAt(1)` is the Phrase row and `(2)`…`(6)` the five
 * groups in catalog order), so every expectation below is a value the reader can point at.
 */
function seedGroupBook() {
    const store = Store.empty();
    const seeded = seedStory(store, { phase: 'summary' });
    const story = store.stories.update(
        seeded.id,
        { summary_mode: 'groups' },
        { ...AUTHOR_ATTR, why: 'seed: a group-managed Summary (R1)' },
        [{ id: seeded.id, rev: seeded.rev }]
    );

    seedBuiltInCrews(store);

    let next = 1;
    const groups = ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!.groups;

    installGroupRevisions(
        store,
        story,
        groups.map((group) => ({ group: store.phraseGroups.require(group.id), content: GROUP_TEXTS[group.key] })),
        { ...AUTHOR_ATTR, why: 'seed: the first group batch installed (R2)' },
        { runRef: 'run_1', workItemRef: 'wi_draft_groups_summary_0_7fc4' }
    );

    const finding = seedFinding(store, story.id, {
        target_ref: 'summary_0',
        criterion_ref: 'C-14',
        title: 'the premise contradicts the Seed',
        detail: 'the Overview keeps a cartographer the Seed destroyed',
        evidence: 'premise: "the cartographer returns" — the Seed states the map was destroyed in 1954',
        cost: 'critical',
        state: 'approved',
        fingerprint: 'C-14|summary_0'
    });

    store.findings.update(
        finding.id,
        { group_refs: [groupOf(groups, 'premise').id] },
        { ...AUTHOR_ATTR, why: 'seed: the defect is scoped to premise (R3)' },
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

    return {
        store,
        story,
        groups: groups.map((group) => store.phraseGroups.require(group.id)),
        groupRefs: groups.map((group) => store.phraseGroups.require(group.id).id)
    };
}

/**
 * The state a `score_sections` seat is dispatched into (D-67): the seat needs a COMPLETE clean
 * selection, so the premise defect has to stop blocking it (an `approved` issue is still an open issue
 * for the selection, which is why this closes it rather than leaving it) and the current vector has to
 * carry the Clean stamp. The vector hash is DERIVED from the selection, never copied.
 */
function withCleanSummary(store: Store, story: Story): string {
    const finding = store.findings.require('finding_0');

    store.findings.update(
        finding.id,
        { state: 'fixed' },
        { ...AUTHOR_ATTR, why: 'seed: the crew fixed the premise defect (D-33c)' },
        [{ id: finding.id, rev: finding.rev }]
    );

    stampCleanRevisions(
        store,
        story,
        {
            seatKey: groupCheckSeatKey(groupVectorHash(groupRevisionVector(store, story.id)), 1),
            runRef: 'run_check_1'
        },
        AUTHOR_ATTR
    );

    const selection = cleanSelectionOf(store, story);

    // The fixture states its own precondition instead of assuming one: an incomplete selection would
    // make `compileSectionScorePrompt` throw and the test would pin a refusal rather than a prompt.
    expect(selection.complete).toBe(true);

    return selection.vector_hash;
}

/**
 * The same book with Phrase ② started, its brief ACCEPTED and its chapter contracts installed and
 * stamped clean — the state a phase-② `review_groups` or `score_sections` seat compiles against. The
 * chapter lane's hash is scoped to the chapter phrase (`cleanSelectionOf(store, story, phraseId)`),
 * which is the difference between grading five sections and grading three contracts.
 */
function seedChapterBook() {
    const book = seedGroupBook();
    const summaryPhrase = storyPhraseByKey(book.store, book.story.id, PHRASE_SUMMARY_KEY)!;
    const started = startPlotlinesPhrase(
        book.store,
        book.story,
        'A keeper, a bird, and a lamp on the last ship.',
        AUTHOR_ATTR
    );
    const brief = createPlotlineBrief(
        book.store,
        book.story,
        started.phrase,
        {
            chapter_count: CHAPTER_SEEDS.length,
            chapters: CHAPTER_SEEDS.map((seed, index) => ({ order: index + 1, seed }))
        },
        AUTHOR_ATTR
    );

    acceptPlotlineBrief(book.store, book.story, brief, AUTHOR_ATTR);

    const chapters = book.store.phraseGroups
        .list()
        .filter((group) => group.phrase_id === started.phrase.id)
        .sort((left, right) => left.order - right.order);

    installGroupRevisions(
        book.store,
        book.story,
        chapters.map((group, index) => ({
            group: book.store.phraseGroups.require(group.id),
            content: `Must happen: chapter ${index + 1} turns the ledger.\nMust change: the keeper stops trusting the roll.`,
            // A chapter install REQUIRES the plotpoints — the `plotlines` mirror is derived from them
            // (`phrase/revisions.ts:installGroupRevisions`), and without them the contract the loop
            // checks would keep the previous pass's fields.
            plotpoints: {
                must_happen: `chapter ${index + 1} turns the ledger`,
                must_change: 'the keeper stops trusting the roll'
            }
        })),
        { ...AUTHOR_ATTR, why: 'seed: the chapter batch installed (T-W2)' },
        { runRef: 'run_ch_1', workItemRef: `wi_draft_groups_${started.phrase.id}_ch` }
    );

    stampCleanRevisions(
        book.store,
        book.story,
        {
            seatKey: groupCheckSeatKey(
                groupVectorHash(groupRevisionVector(book.store, book.story.id, started.phrase.id)),
                1
            ),
            runRef: 'run_check_2',
            phraseId: started.phrase.id
        },
        AUTHOR_ATTR
    );

    const selection = cleanSelectionOf(book.store, book.story, started.phrase.id);

    expect(selection.complete).toBe(true);

    return {
        ...book,
        chapters,
        chapterRefs: chapters.map((group) => group.id),
        chapterVectorHash: selection.vector_hash
    };
}

// ---------------------------------------------------------------------------
// 0 — The catalogue premise: which crews exist, and which of them hold tools
// ---------------------------------------------------------------------------

describe('the crews the two tool-less seats bind to', () => {
    it('ships a score-only reader and two screening Critics, and none of the three names a tool', () => {
        // The three copies the structured seats are hard-bound to
        // (`phase1-prompt.ts:SCREEN_TEMPLATE_SLUG`, `PLOTLINES_SCREEN_TEMPLATE_SLUG`,
        // `SCORE_TEMPLATE_SLUG`). Any tool verb here reaches a run that cannot call it.
        expect(builtInRolePrompt('critic-screening', 'critic').startsWith('You are the phase-① Reviewer in structured mode.')).toBe(true);
        expect(builtInRolePrompt('critic-screening-plotlines', 'critic').startsWith('You are the phase-② Reviewer in structured mode.')).toBe(true);
        expect(builtInRolePrompt('reader-score', 'reader').startsWith('You are the Scoring reader.')).toBe(true);

        for (const slug of ['critic-screening', 'critic-screening-plotlines', 'reader-score'] as const) {
            for (const verb of TOOL_VERBS) {
                // Plain, not only backticked: in a role copy the bare word IS the instruction.
                expect(builtInRolePrompt(slug, slug === 'reader-score' ? 'reader' : 'critic')).not.toContain(verb);
            }
        }
    });

    it('keeps the deep-review angles and the tool reader tool-using, so the seat guards have teeth', () => {
        // Without this pin the four `not.toContain(angle copy)` assertions below would pass against an
        // empty or reworded catalogue. Each angle instructs `submitVerdict`, and `reader-consistency`
        // instructs the ledger, the finding call and the task call — the exact three the score seat may
        // not do (P6).
        for (const slug of DEEP_REVIEW_SLUGS) expect(builtInRolePrompt(slug, 'critic')).toContain('submitVerdict');

        const toolReader = builtInRolePrompt(TOOL_READER_SLUG, 'reader');

        expect(toolReader).toContain('readLedger');
        expect(toolReader).toContain('raiseFinding');
        expect(toolReader).toContain('createTask');
        expect(toolReader).toContain('Your output is a verdict, triaged findings, and the tasks that would fix them.');
    });
});

// ---------------------------------------------------------------------------
// 1 — The schemas, pinned from the schema side first
// ---------------------------------------------------------------------------

describe('GroupReviewSchema — the shape the review seat answers to', () => {
    /** Every issue-level property, as a sorted set (the parity map below is checked against it). */
    const ISSUE_FIELDS = Object.keys(GroupReviewSchema.properties.issues.items.properties).sort();

    it('carries exactly the fields the prompt asks for, plus the optional fix_hint', () => {
        // Sorted-set comparison: the MEMBERSHIP is the contract (a field the prompt asks for that is
        // absent here is a refused run, and a field here that the prompt never mentions is a silent
        // requirement), while the declaration order in `group-review.ts` is only the validator's
        // property-emission order and is not what this guardrail defends.
        expect(ISSUE_FIELDS).toEqual(['criterion', 'detail', 'fix_hint', 'group_quotes', 'group_refs', 'location', 'quote', 'severity']);
        expect(Object.keys(GroupReviewSchema.properties).sort()).toEqual(['fix_verifications', 'issues']);
    });

    it('closes severity at the two words, requires a non-empty group_refs, and keeps group_quotes optional', () => {
        const issue = GroupReviewSchema.properties.issues.items;

        // The transport and every "blocking" predicate in `loop/records.ts` read exactly this pair; a
        // third word would split one rule across two vocabularies.
        expect(issue.properties.severity).toEqual({ type: 'string', enum: ['critical', 'high'] });
        expect(issue.properties.group_refs).toEqual({
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 }
        });
        // `group_quotes` is the per-group evidence array: item shape closed on `group_ref` + `quote`.
        expect(issue.properties.group_quotes).toEqual({
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    group_ref: { type: 'string', minLength: 1 },
                    quote: { type: 'string', minLength: 1 },
                    location: { type: 'string' }
                },
                required: ['group_ref', 'quote'],
                additionalProperties: false
            }
        });
        // REQUIRED set, in the order the validator emits it. `group_quotes` is deliberately absent: the
        // wire shape stays back-compatible for a single-group issue, and the coverage rule
        // (`parseGroupReviewAnswer`) is what makes it mandatory per additional group.
        expect(issue.required).toEqual(['severity', 'criterion', 'location', 'quote', 'detail', 'group_refs']);
        expect(GroupReviewSchema.required).toEqual(['issues']);

        // Closed at all three levels: `llm/structured.ts` rejects an unexpected key at each one, so an
        // answer that invents a field is refused rather than stored.
        expect(GroupReviewSchema.additionalProperties).toBe(false);
        expect(issue.additionalProperties).toBe(false);
        expect(issue.properties.group_quotes.items.additionalProperties).toBe(false);
    });
});

describe('SectionScoresSchema — the shape the score seat answers to', () => {
    it('names exactly the four scored fields, requires all of them, and closes both levels', () => {
        const item = SectionScoresSchema.properties.sections.items;

        // The four fields the score contract asks for — and nothing else. A fifth field here needs a
        // sentence in `SECTION_SCORE_INSTRUCTION`, or every answer is refused by `required`.
        expect(Object.keys(item.properties).sort()).toEqual(['evidence', 'group_ref', 'rationale', 'score']);
        expect(item.required).toEqual(['group_ref', 'score', 'rationale', 'evidence']);
        // `integer` is honoured by the provider schema; `phrase/section-scores.ts` re-checks the range,
        // so the scale lives in the instruction and not here.
        expect(item.properties).toEqual({
            group_ref: { type: 'string', minLength: 1 },
            score: { type: 'integer' },
            rationale: { type: 'string', minLength: 1 },
            evidence: { type: 'string', minLength: 1 }
        });
        expect(Object.keys(SectionScoresSchema.properties)).toEqual(['sections']);
        expect(SectionScoresSchema.required).toEqual(['sections']);
        expect(SectionScoresSchema.additionalProperties).toBe(false);
        expect(item.additionalProperties).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 2 — The phase-① review seat: the voice, the contract text, and the field parity
// ---------------------------------------------------------------------------

/**
 * The field ↔ sentence map the parity check runs on. Each sentence is the exact engine-owned wording
 * that asks for that field, so the assertion fails when EITHER half moves: reword the instruction
 * without renaming the field, or rename a schema field without following the prompt.
 */
const REVIEW_FIELD_PROMISES: Array<{ field: string; sentence: string }> = [
    {
        field: 'group_refs',
        sentence: 'EVERY issue you report names its `group_refs`: the group ids shown in the OVERVIEW section above.'
    },
    {
        field: 'group_quotes',
        sentence:
            'Put the primary quote in `quote`; for every OTHER group you name, add a `group_quotes` entry with that ' +
            'group’s `group_ref`, its `quote` and its `location` — a group named without a quote is refused, because ' +
            'naming it is a claim that you read it.'
    },
    {
        // One sentence carries the three evidence fields the answer is graded on (D-15).
        field: 'quote',
        sentence:
            'Quote the offending field verbatim in `quote`, name the field in `location`, say in `detail` what is ' +
            'wrong and where, and cite `C-14`, `C-15` or `seed` in `criterion`.'
    },
    {
        // `detail` joined the sentence on 2026-11-27. It has been REQUIRED by the schema
        // (`required` + `minLength: 1`) since the field landed, and until now no turn named it — the gap the
        // pin in the seat test below used to record as an absence.
        field: 'detail',
        sentence: 'say in `detail` what is wrong and where'
    },
    {
        field: 'fix_verifications',
        sentence: 'Answer with one `fix_verifications` entry for EVERY task it lists, and none for anything else'
    }
];

/**
 * Lookup by field, so the pins below name the FIELD they guard rather than a position in the array above
 * (inserting an entry must not silently re-point an unrelated pin).
 */
const REVIEW_PROMISE: Record<string, string> = Object.fromEntries(
    REVIEW_FIELD_PROMISES.map((promise) => [promise.field, promise.sentence] as const)
);

describe('the phase-① group review seat (review_groups, toolMode none)', () => {
    it('sends the critic-screening copy plus the GroupReview contract, and its pool pick cannot change it', () => {
        const { store, story, groupRefs } = seedGroupBook();
        const compiled = compileGroupReviewPrompt(store, story.id, { groupRefs, fixRefs: ['task_0'] });

        // The WHOLE system turn: the phase-① screening crew, plus the contract naming the schema
        // CONSTANT — so the label a downgraded provider reads (`json_object`, §4.2) is the name of the
        // very schema imported above.
        expect(compiled.system).toBe(
            `${builtInRolePrompt('critic-screening', 'critic')}\n\n${outputContract(GROUP_REVIEW_SCHEMA_NAME)}`
        );
        expect(GROUP_REVIEW_SCHEMA_NAME).toBe('GroupReview');

        // Not a deep-review angle's copy, and not Phrase ②'s: each absent copy is named by its own row,
        // so the pin survives a reword but not a wrong slug.
        for (const slug of DEEP_REVIEW_SLUGS) expect(compiled.system).not.toContain(builtInRolePrompt(slug, 'critic'));

        expect(compiled.system).not.toContain(builtInRolePrompt('critic-screening-plotlines', 'critic'));
        expect(compiled.system).not.toContain('You are the phase-② Reviewer in structured mode.');

        // `item.templateRef` reaches the compiler as `opts.templateSlug`
        // (`run/executor.ts:876-883`). For a structured review seat that row is a scheduling label — a
        // POOL PICK, whose rows are the D-17d divergence crews — and `compileGroupReviewPrompt` never
        // consults it: the voice comes from the phrase alone (`canonical` above; `slugFor` is used by the
        // draft and lock compilers, not by this one), so every phase-① prompt keeps its hash and no pool
        // edit can re-brief a tool-less seat. This is the seat-level half of that rule.
        const poolPicked = compileGroupReviewPrompt(store, story.id, {
            groupRefs,
            fixRefs: ['task_0'],
            templateSlug: 'critic-genre',
            roleName: 'critic'
        });

        expect(poolPicked.system).toBe(compiled.system);
        expect(poolPicked.hash).toBe(compiled.hash);
    });

    it('carries the Summary screening contract, the group attribution rule and the group_quotes evidence rule', () => {
        const { store, story, groupRefs } = seedGroupBook();
        const compiled = compileGroupReviewPrompt(store, story.id, { groupRefs, fixRefs: ['task_0'] });

        // The heading that says what the artifact IS (the five groups as they stand), and the two
        // engine-owned blocks the answer is graded against. Both live in the USER turn so an Author's
        // custom role prompt cannot delete them (R7).
        expect(compiled.user).toContain(
            '## OVERVIEW — the five groups as they stand (every issue names the groups it is about)'
        );
        // The phase calibration: a Summary is a contract of facts, and these two words are reserved for
        // what it has to get RIGHT (H1/R6 + T3).
        expect(compiled.user).toContain(
            'Report ONLY critical and high issues, and reserve those two words for what a Summary has to get RIGHT: ' +
                'a critical contradicts the Seed Brief or a critical Knowledge entry'
        );
        // R3's attribution, and D-15's per-group evidence — the sentence the parse below enforces.
        expect(compiled.user).toContain(REVIEW_PROMISE.group_refs);
        expect(compiled.user).toContain(REVIEW_PROMISE.group_quotes);
        // H1/R2's certificate rides ONLY with the fix list the job carried.
        expect(compiled.user).toContain('## FIX TASKS (verify every one against the Overview below, by its id)');
        expect(compiled.user).toContain(REVIEW_PROMISE.fix_verifications);

        // The chapter lane's wording must not leak onto a Summary seat: these two sentences are the
        // chapter twin's identity, and a lane refactor that merged them would silently re-grade a
        // Summary against chapter criteria.
        expect(compiled.user).not.toContain('what a CHAPTER CONTRACT has to get RIGHT');
        expect(compiled.user).not.toContain('JUDGE THE CHAPTERS TOGETHER.');
        // Including its `group_refs` rule, which is engine-owned in the chapter lane (see the phase-② test):
        // a Summary seat told the chapter ids are the refs would scope every issue to a chapter row.
        expect(compiled.user).not.toContain('EVERY issue names its `group_refs` — the chapter ids printed in the headings.');
    });

    it('instructs no tool verb in either turn, while still telling the run it has none', () => {
        const { store, story, groupRefs } = seedGroupBook();
        const compiled = compileGroupReviewPrompt(store, story.id, { groupRefs, fixRefs: ['task_0'] });

        for (const verb of TOOL_VERBS) {
            // Backticked = the instruction form the tool tables use, and the form a model imitates.
            expect(compiled.system).not.toContain(`\`${verb}\``);
            expect(compiled.user).not.toContain(`\`${verb}\``);
            // Plain, too: an unbackticked verb in either turn is still a sentence telling the seat to
            // call something it cannot call.
            expect(compiled.system).not.toContain(verb);
            expect(compiled.user).not.toContain(verb);
        }

        // The allowed sentence, and the one this guardrail must NOT achieve its pins by deleting: the
        // seat is tool-less, which is a fact the run has to be told.
        expect(compiled.system).toContain('You have no tools and exactly one turn.');
    });

    it('asks for no issue field the GroupReview schema does not carry', () => {
        const { store, story, groupRefs } = seedGroupBook();
        const compiled = compileGroupReviewPrompt(store, story.id, { groupRefs, fixRefs: ['task_0'] });
        const issueFields = Object.keys(GroupReviewSchema.properties.issues.items.properties);
        const topFields = Object.keys(GroupReviewSchema.properties);

        for (const promise of REVIEW_FIELD_PROMISES) {
            expect(compiled.user).toContain(promise.sentence);

            // Whichever level carries it, the field the sentence demands exists in the schema the
            // transport advertises — the drift that costs a run is a named field the validator closes.
            expect(topFields.includes(promise.field) || issueFields.includes(promise.field)).toBe(true);
        }

        // `location` and `criterion` are demanded by the same quote sentence pinned above, so the schema
        // has to carry them under those exact names.
        for (const field of ['location', 'criterion', 'quote'] as const) {
            expect(issueFields).toContain(field);
            expect(GroupReviewSchema.properties.issues.items.properties[field].type).toBe('string');
        }

        // `detail` IS a required field — `required` + `minLength: 1`, both enforced by `llm/structured.ts` —
        // and the engine-owned screen now NAMES it (`phase1-prompt.ts:SCREEN_INSTRUCTION`, 2026-11-27). It
        // used to be the one required field no turn mentioned, which left a provider answering in
        // `json_object` mode (§4.2's fallback, where the schema is not on the wire) with nothing telling it
        // the field had to be non-empty; the ABSENCE pin that stood here recorded that gap. Pinned from both
        // sides now: the sentence the answer is graded on, and the requirement that sentence exists to meet.
        expect(compiled.user).toContain(REVIEW_PROMISE.detail);
        expect(compiled.user).toContain(
            'say in `detail` what is wrong and where, and cite `C-14`, `C-15` or `seed` in `criterion`.'
        );
        // One copy, in the lane that has the field: a second sentence asking for `detail` in the same turn
        // is the duplication D-33c's de-duplication removed everywhere else in this prompt.
        expect(compiled.user.match(/`detail`/g)).toHaveLength(1);
        expect(GroupReviewSchema.properties.issues.items.required).toContain('detail');
        expect(GroupReviewSchema.properties.issues.items.properties.detail).toEqual({ type: 'string', minLength: 1 });
    });
});

// ---------------------------------------------------------------------------
// 3 — The phase-② review seat: the chapter lane's structured Critic
// ---------------------------------------------------------------------------

describe('the phase-② chapter review seat (review_groups over chapter contracts)', () => {
    it('sends the critic-screening-plotlines copy plus the same GroupReview contract, never an angle copy', () => {
        const { store, story, chapterRefs } = seedChapterBook();
        const compiled = compileGroupReviewPrompt(store, story.id, { groupRefs: chapterRefs });

        // Phrase ②'s structured seat gets its OWN built-in: the Summary copy's C-14/C-15 criteria and
        // its "a Summary is not prose" calibration are wrong for a contract review
        // (`phase1-prompt.ts:PLOTLINES_SCREEN_TEMPLATE_SLUG`).
        expect(compiled.system).toBe(
            `${builtInRolePrompt('critic-screening-plotlines', 'critic')}\n\n${outputContract(GROUP_REVIEW_SCHEMA_NAME)}`
        );
        expect(compiled.system.startsWith('You are the phase-② Reviewer in structured mode.')).toBe(true);

        // The four angle crews are the pool this seat is drawn from, and none of them may be its voice
        // by default: each copy instructs `submitVerdict`, which a one-turn no-tool run cannot call.
        for (const slug of DEEP_REVIEW_SLUGS) {
            const angle = builtInRolePrompt(slug, 'critic');

            expect(angle).toContain('submitVerdict');
            expect(compiled.system).not.toContain(angle);
        }

        expect(compiled.system).not.toContain(builtInRolePrompt('critic-screening', 'critic'));
        expect(compiled.system).not.toContain('You are the phase-① Reviewer in structured mode.');

        // The fix heading names the artifact too. With `opts.fixRefs` unspecified the compiler hands the
        // seat every open task (the job's own list is what the dispatch froze), and the chapter lane says
        // so in its own words — a Summary-screen heading over a chapter review is the same
        // phase-mismatch defect in the section that carries the evidence standard.
        const unspecced = compileGroupReviewPrompt(store, story.id, { groupRefs: chapterRefs });

        expect(unspecced.user).toContain('## FIX TASKS (verify every one against the chapter contracts below, by its id)');
        expect(unspecced.user).toContain(
            'The FIX TASKS section above names the changes this draft was asked to make.'
        );

        // THE PHASE-② DEFECT THIS SEAT EXISTS FOR: `item.templateRef` reaches the compiler as
        // `opts.templateSlug` (`run/executor.ts:876-883`), and in this lane that row is the rotating
        // angle pool — every angle copy instructs `submitVerdict`, which a `toolMode: 'none'` seat cannot
        // call. `compileGroupReviewPrompt` therefore derives its voice from the PHRASE alone
        // (`canonical`, never `slugFor`, unlike the draft and lock seats), so no scheduling pick can hand
        // this run a tool-using brief. Pinning the label as a no-op is what keeps a later refactor that
        // wires `slugFor` back in from quietly re-importing the defect.
        const angled = compileGroupReviewPrompt(store, story.id, {
            groupRefs: chapterRefs,
            templateSlug: 'critic-genre',
            roleName: 'critic'
        });

        expect(angled.system).toBe(compiled.system);
        expect(angled.system).not.toContain(builtInRolePrompt('critic-genre', 'critic'));
        expect(angled.system).not.toContain('submitVerdict');
    });

    it('carries the chapter-contract screen and the plotlines review block, not the Summary wording', () => {
        const { store, story, chapterRefs } = seedChapterBook();
        // `fixRefs: []` — the job was handed no work to certify. Left unspecified, the compiler would
        // render EVERY open fix task (the book's summary-scope task included) and the certificate
        // sentence with it, which is the pair the next test pins separately.
        const compiled = compileGroupReviewPrompt(store, story.id, { groupRefs: chapterRefs, fixRefs: [] });

        expect(compiled.user).toContain(
            '## CHAPTER CONTRACTS — every entry as it stands (every issue names the groups it is about)'
        );
        // The chapter twin of the Summary screen: its own severities, and its OWN criteria ladder.
        expect(compiled.user).toContain(
            'Report ONLY critical and high issues, and reserve those two words for what a CHAPTER CONTRACT has to get RIGHT'
        );
        expect(compiled.user).toContain('Never cite `C-14` or `C-15` here: those are the Summary’s criteria.');
        // The controller's phase law (seam S12), not this file's Summary constant.
        expect(compiled.user).toContain('JUDGE THE CHAPTERS TOGETHER.');

        // FIELD PARITY, phase ② — the schema's required `detail` is named in THIS lane too, in the chapter's
        // own address terms (chapter and section, not the Summary's field): `CONTRACT_SCREEN_INSTRUCTION`
        // carries the same clause the Summary screen gained, so the seat that answers with `GroupReview` is
        // told about a required field whether or not the provider puts the schema on the wire (§4.2).
        expect(compiled.user).toContain(
            'Quote the offending line verbatim in `quote`, name the chapter it came from in `location`, say in ' +
                '`detail` what is wrong and where, and cite `C-7`, `C-8` or `C-9` in `criterion` for a chapter ' +
                'contract, `C-0` through `C-6` for the plotline contract the chapter fails, or `seed` for a direct ' +
                'breach of the phrase seed.'
        );
        expect(compiled.user.match(/`detail`/g)).toHaveLength(1);

        // THE `group_refs` RULE IS ENGINE-OWNED IN THIS LANE NOW (2026-11-27): it sits inside
        // `CONTRACT_SCREEN_INSTRUCTION`, in the USER turn, beside the calibration — so an Author editing the
        // `critic-screening-plotlines` role copy cannot delete the coverage rule `parseGroupReviewAnswer`
        // refuses on (R7). The chapter wording is the discriminator: the Summary block says "the group ids
        // shown in the OVERVIEW section above", this one says "the chapter ids printed in the headings".
        expect(compiled.user).toContain(
            'EVERY issue names its `group_refs` — the chapter ids printed in the headings. Put the chapter your ' +
                '`quote` came from FIRST in `group_refs`, and for every other chapter you name add a `group_quotes` ' +
                'entry with its `group_ref`, `quote` and `location`: a chapter named without a quote is refused.'
        );

        // THE PHASE-MISMATCH PIN: the Summary screen's C-14/C-15 calibration and its OVERVIEW-worded
        // attribution rule are what a chapter Critic used to be handed. Neither may appear — note the
        // chapter screen quotes C-14/C-15 only to forbid them, so the whole sentence, not the criterion
        // code, is the discriminator.
        expect(compiled.user).not.toContain('what a Summary has to get RIGHT');
        expect(compiled.user).not.toContain('the group ids shown in the OVERVIEW section above');
        // And the Summary screen's `detail` sentence, which is the same instruction addressed to a Summary:
        // its field names are the lane's, so a chapter seat reading it is being briefed with the wrong artifact.
        expect(compiled.user).not.toContain('name the field in `location`, say in `detail` what is wrong and where');
        // And with no fix list on the job, no certificate is asked for.
        expect(compiled.user).not.toContain('## FIX TASKS');
        expect(compiled.user).not.toContain('fix_verifications');
    });

    it('instructs no tool verb, and its role copy still promises the coverage the parse enforces', () => {
        const { store, story, chapterRefs } = seedChapterBook();
        const compiled = compileGroupReviewPrompt(store, story.id, { groupRefs: chapterRefs });

        for (const verb of ['raiseFinding', 'submitVerdict', 'createTask', 'readLedger', 'readSummary'] as const) {
            expect(compiled.system).not.toContain(verb);
            expect(compiled.user).not.toContain(verb);
        }

        // The seat produces REVIEW NOTES, not findings — the sentence that keeps a `toolMode: 'none'`
        // pass from believing it is filing something.
        expect(compiled.system).toContain('it does not file findings, open tasks, or submit a verdict');

        // PARITY, phase ②: the chapter lane's `group_quotes` coverage rule sits in the ROLE copy (the
        // Author-editable system turn), while `parseGroupReviewAnswer` enforces it unconditionally. A
        // template edit that dropped this sentence would leave the engine refusing answers the prompt
        // never warned about, so the pin lives here. It now runs to the `detail` clause the same sentence
        // gained, because the system turn is where this seat is told the required field exists at all.
        expect(compiled.system).toContain(
            'Put the primary quote in `quote`; for every OTHER chapter you name, add a `group_quotes` entry with that ' +
                'chapter’s `group_ref`, its `quote` and its `location` — do not name a chapter you have not quoted ' +
                'from. `detail` is what is wrong and where (chapter and section), and it is required.'
        );
        expect(compiled.system.match(/`detail`/g)).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// 4 — The section score seat: the score-only voice on both lanes
// ---------------------------------------------------------------------------

describe('the section score seat (score_sections, toolMode none, phase ①)', () => {
    it('sends the reader-score copy plus the SectionScores contract, and ignores the tool-carrying crew label', () => {
        const { store, story, groupRefs } = seedGroupBook();
        const vectorHash = withCleanSummary(store, story);
        const compiled = compileSectionScorePrompt(store, story.id, { groupRefs, vectorHash });

        expect(compiled.system).toBe(
            `${builtInRolePrompt('reader-score', 'reader')}\n\n${outputContract(SECTION_SCORES_SCHEMA_NAME)}`
        );
        expect(SECTION_SCORES_SCHEMA_NAME).toBe('SectionScores');
        expect(compiled.system.startsWith('You are the Scoring reader.')).toBe(true);

        // The defect D-65 named: `reader-consistency` is a TOOL-CARRYING review reader, and briefing the
        // score seat with it told a run that may file nothing to read the ledger and open tasks (P6).
        const toolReader = builtInRolePrompt(TOOL_READER_SLUG, 'reader');

        expect(compiled.system).not.toContain(toolReader);
        expect(compiled.system).not.toContain('Your output is a verdict, triaged findings, and the tasks that would fix them.');

        // Like the review seat, the score seat ignores its slug outright
        // (`phase1-prompt.ts:compileSectionScorePrompt` hard-codes `SCORE_TEMPLATE_SLUG`): a score is a
        // score whatever row the queue picked, so the label cannot change a byte of the cacheable prefix
        // and `reader-consistency` can never reach this run by accident.
        const mislabeled = compileSectionScorePrompt(store, story.id, {
            groupRefs,
            vectorHash,
            templateSlug: TOOL_READER_SLUG,
            roleName: 'reader'
        });

        expect(mislabeled.system).toBe(compiled.system);
        expect(mislabeled.hash).toBe(compiled.hash);
    });

    it('carries the score contract and names every field SectionScoresSchema requires', () => {
        const { store, story, groupRefs } = seedGroupBook();
        const vectorHash = withCleanSummary(store, story);
        const compiled = compileSectionScorePrompt(store, story.id, { groupRefs, vectorHash });

        expect(compiled.user).toContain(
            '## REVIEWED OVERVIEW — every section, scored (name each group_ref exactly once)'
        );
        // D-65's scale: the range, the three things judged, and P6's boundary in one block.
        expect(compiled.user).toContain('SCORE EVERY SECTION ONCE. For each group printed above, give a whole number from 0 to 100');
        expect(compiled.user).toContain(
            'Copy each section’s `group_ref` from the heading above into `group_ref`, give ONE short `rationale` ' +
                '(the reason for the number, in a sentence) and ONE `evidence` quote taken verbatim from the section you scored'
        );
        expect(compiled.user).toContain('it files no finding, opens no task, grades no fix, edits nothing');

        // FIELD PARITY, schema → prompt: every required field of the answer has a sentence asking for
        // it, and a renamed schema field would leave its sentence missing. `score` is asked for as the
        // scale sentence rather than as a backticked field, which is what its pin names.
        const fieldSentences: Record<string, string> = {
            group_ref: 'into `group_ref`',
            score: 'give a whole number from 0 to 100',
            rationale: 'give ONE short `rationale`',
            evidence: 'ONE `evidence` quote taken verbatim'
        };

        expect(Object.keys(fieldSentences).sort()).toEqual(
            [...SectionScoresSchema.properties.sections.items.required].sort()
        );

        for (const field of SectionScoresSchema.properties.sections.items.required) {
            expect(compiled.user).toContain(fieldSentences[field]);
        }

        // A score pass grades the TEXT, never the queue: no fix list, so no certificate either.
        expect(compiled.user).not.toContain('## FIX TASKS');
        expect(compiled.user).not.toContain('fix_verifications');
    });

    it('instructs no tool verb and promises no verdict in either turn', () => {
        const { store, story, groupRefs } = seedGroupBook();
        const vectorHash = withCleanSummary(store, story);
        const compiled = compileSectionScorePrompt(store, story.id, { groupRefs, vectorHash });

        for (const verb of ['raiseFinding', 'createTask', 'readLedger'] as const) {
            expect(compiled.system).not.toContain(verb);
            expect(compiled.user).not.toContain(verb);
        }

        // `reader-consistency`'s opening sentence is the verdict shape; a score row has no verdict field
        // to leak one into (D-65's P6 exception).
        expect(compiled.system).not.toContain('Your output is a verdict');
        expect(compiled.user).not.toContain('Your output is a verdict');
        expect(compiled.system).toContain('You have no tools and exactly one turn.');
    });
});

describe('the section score seat, phase ② (chapter contracts)', () => {
    it('keeps the score-only voice and swaps in the plotlines score instruction', () => {
        const { store, story, chapterRefs, chapterVectorHash } = seedChapterBook();
        const compiled = compileSectionScorePrompt(store, story.id, {
            groupRefs: chapterRefs,
            vectorHash: chapterVectorHash
        });

        // The voice is lane-independent: the score seat's crew is always the score-only built-in, because
        // its contract is the same shape on both phrases (`SectionScores`, one entry per entry).
        expect(compiled.system).toBe(
            `${builtInRolePrompt('reader-score', 'reader')}\n\n${outputContract(SECTION_SCORES_SCHEMA_NAME)}`
        );
        expect(compiled.system).not.toContain(builtInRolePrompt(TOOL_READER_SLUG, 'reader'));

        // The CHAPTER instruction (the controller's `instructions.score` slot), with the chapter's own
        // heading — a chapter Reader told it is grading "sections of a Summary" grades the wrong thing.
        expect(compiled.user).toContain(
            '## REVIEWED CHAPTER CONTRACTS — every entry, scored (name each group_ref exactly once)'
        );
        expect(compiled.user).toContain('SCORE EVERY CHAPTER ONCE, a whole number from 0 to 100');
        expect(compiled.user).toContain('Name every chapter exactly once, with one `rationale` and one `evidence` quote taken verbatim from that entry.');
        expect(compiled.user).toContain('This pass reports a number: it files no finding, opens no task, and edits nothing.');
        expect(compiled.user).not.toContain('SCORE EVERY SECTION ONCE');

        for (const field of SectionScoresSchema.properties.sections.items.required) {
            // `group_ref` is named by the heading itself in this lane, which is why the heading string is
            // pinned above rather than reconstructed from the instruction.
            expect(`${compiled.system}\n${compiled.user}`).toContain(
                field === 'group_ref' ? 'name each group_ref exactly once' : field === 'score' ? 'a whole number from 0 to 100' : `one \`${field}\``
            );
        }

        for (const verb of ['raiseFinding', 'createTask', 'readLedger'] as const) {
            expect(compiled.system).not.toContain(verb);
            expect(compiled.user).not.toContain(verb);
        }

        expect(compiled.system).not.toContain('Your output is a verdict');
    });
});

// ---------------------------------------------------------------------------
// 5 — The coverage contract the review prompt promises, at the validator
// ---------------------------------------------------------------------------

/**
 * One review issue, in the shape the prompt teaches: the primary `quote` proves the group listed FIRST
 * in `group_refs`, and `group_quotes` carries every other named group.
 */
const reviewIssue = (groupRefs: string[], groupQuotes?: Array<{ group_ref: string; quote: string; location?: string }>) => ({
    severity: 'critical' as const,
    criterion: 'C-14',
    location: 'the Ending, line 1',
    quote: 'She floods the valley and keeps the map.',
    detail: 'The Ending answers a promise the Promise never makes.',
    group_refs: groupRefs,
    ...(groupQuotes === undefined ? {} : { group_quotes: groupQuotes })
});

describe('parseGroupReviewAnswer — the coverage rule the review prompt states', () => {
    it('refuses a multi-group issue that quotes only its primary group', () => {
        const { store, story, groups } = seedGroupBook();
        const premise = groupOf(groups, 'premise');
        const promise = groupOf(groups, 'promise');

        // The prompt says "a group named without a quote is refused"; this is that refusal, sentence for
        // sentence, naming the group that has no quote. Before `group_quotes` existed this shape was the
        // only one the schema allowed, which is why the rule sits in the parse and not in the schema.
        expect(parseGroupReviewAnswer(store, story.id, { issues: [reviewIssue([premise.id, promise.id])] })).toEqual({
            ok: false,
            refusal:
                `an issue naming 2 groups has to quote every one of them; ${promise.id} has no quote — put the primary ` +
                "quote's group first in `group_refs` and add a `group_quotes` entry for every other group (R3, D-15)"
        });
    });

    it('accepts a multi-group issue once every additional group carries a group_quotes entry, and preserves them', () => {
        const { store, story, groups } = seedGroupBook();
        const premise = groupOf(groups, 'premise');
        const promise = groupOf(groups, 'promise');
        const groupQuotes = [
            {
                group_ref: promise.id,
                quote: GROUP_TEXTS.promise,
                location: 'the Promise, line 1'
            }
        ];

        // The accepted answer is the ANSWER, verbatim: R3's refs, D-15's per-group evidence, and no
        // invented fields. `fix_verifications` is absent because this answer carried none.
        expect(
            parseGroupReviewAnswer(store, story.id, {
                issues: [reviewIssue([premise.id, promise.id], groupQuotes)]
            })
        ).toEqual({
            ok: true,
            review: {
                issues: [
                    {
                        severity: 'critical',
                        criterion: 'C-14',
                        location: 'the Ending, line 1',
                        quote: 'She floods the valley and keeps the map.',
                        detail: 'The Ending answers a promise the Promise never makes.',
                        group_refs: [premise.id, promise.id],
                        group_quotes: groupQuotes
                    }
                ]
            }
        });
    });

    it('refuses a group_quotes entry the issue did not name, and one for an id the Story does not have', () => {
        const { store, story, groups } = seedGroupBook();
        const premise = groupOf(groups, 'premise');
        const promise = groupOf(groups, 'promise');

        // Evidence for an UNNAMED group is evidence no scope can be closed on: the entry's id has to be
        // one the same issue already carries in `group_refs`.
        expect(
            parseGroupReviewAnswer(store, story.id, {
                issues: [reviewIssue([premise.id], [{ group_ref: promise.id, quote: GROUP_TEXTS.promise, location: 'the Promise' }])]
            })
        ).toEqual({
            ok: false,
            refusal:
                "a `group_quotes` entry must quote a group named in the same issue's `group_refs`, using an id this " +
                'Story has and a non-empty quote (R3, D-15)'
        });

        // An id from outside the book entirely — the same refusal, because the check is one membership
        // test over the phrase's rows and the issue's own refs.
        expect(
            parseGroupReviewAnswer(store, story.id, {
                issues: [reviewIssue([premise.id, promise.id], [{ group_ref: 'group_does_not_exist', quote: 'a quote', location: 'x' }])]
            })
        ).toEqual({
            ok: false,
            refusal:
                "a `group_quotes` entry must quote a group named in the same issue's `group_refs`, using an id this " +
                'Story has and a non-empty quote (R3, D-15)'
        });
    });
});
