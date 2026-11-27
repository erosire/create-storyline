// The loop's test rig: the REAL store, criteria engine, Digest builder and run executor, with only the
// crew (the model) and the tool layer replaced.
//
// WHY A RIG IN `src/server/loop/` AND NOT just the run layer's mock: the loop's acceptance rows (W4,
// W4e, W5, W7, §15's slice) are about what the SWEEP DECIDES after a run reports — a verdict lands, the
// chapter is judged, the phase locks, the drain probe comes back clean. Only the real `RunExecutor`
// produces the run rows, the brief, the teardown and the `RunResult` the engine reads, and only the real
// `CriteriaEngine` decides whether a phase Goal passes. Both are landed modules, so the rig wires them
// together and leaves exactly two doubles in place:
//
//   * the CHAT double (`MockChatClient`), which is request-driven — it reads the Work Item out of the
//     live run rows and answers with the tool calls that Work Item's job names. It is not scripted by
//     call order, because a sweep dispatches in an order the test does not control;
//   * the TOOL runtime (`MockToolRuntime`, W5's double for §8's catalogue), with two overrides this
//     package needs and W2's default does not provide: a Writer's `editChapter` produces a COMPETING
//     revision (P13/D-21: drafts compete; the body lands only when an Editor selects), and
//     `selectRevision` applies the winner's body, which is what "the one that survives" means.
//
// ONE CONSEQUENCY OF P1 WORTH NAMING: the rig never hands a Work Item to the chat double. The engine
// builds it, the executor consumes it, and the rig recovers it from the store's live run rows plus the
// items the patched `execute` remembered — so a test cannot accidentally assert against a job object
// that never existed in the store.
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { RunExecutor } from '../run/executor';
import {
    MockToolRuntime,
    seedChapter,
    seedDigest,
    seedFinding,
    seedGoal,
    seedIdea,
    seedPlotline,
    seedRevision,
    seedTask,
    seedTemplate,
    type MockToolHandler
} from '../run/mock';
import { MockChatClient, calls, msg } from '../llm/mock';
import { Store } from '../store/store';
import { LoopEngine } from './engine';
import { LIVE_RUN_STATES, PLOTLINES_STRUCTURE_ITEM_PREFIX, researchKeyOf } from './records';
import { DEFAULT_GLOBAL_MAX_CONCURRENT } from './types';
import { seedHashOf } from '../../shared/seed-hash';
// F2 — the Phrase-② structuring seat's own write. The rig used to answer that seat with the phase-① tool;
// these are the domain calls the product's `tools/plotlines.ts:structurePlotlines` makes, and the reads its
// P5 hash is computed from (`phrase/catalog.ts:phraseSeedOf` — never `stories.idea`).
import { phraseSeedOf, storyPhraseByKey } from '../phrase/catalog';
import { acceptPlotlineBrief, createPlotlineBrief } from '../phrase/controllers/plotlines';
import { PHRASE_PLOTLINES_KEY } from '../../shared/phrase';
import type { ChatRequest, ChatResponse, MockHandler } from '../llm';
import type { ToolResult } from '../run/types';
import type { WorkItem } from '../run/types';
import type {
    ChapterDraft,
    GroupDraft,
    GroupLockDecision,
    GroupReview,
    IssueList,
    SectionScores,
    SummarySample
} from '../../shared/schemas';
import type { Cost, Finding, SampledFixVerification, Story } from '../../shared/types';
import type { LoopEngineConfig, SweepReport } from './types';

// ---------------------------------------------------------------------------
// The scripted behaviour the chat double follows
// ---------------------------------------------------------------------------

/** One tool call the scripted crew makes, in the shape `llm/mock.calls` wants. */
export type ScriptCall = { name: string; args?: Record<string, unknown> };

/** What the crew does with a finding it is asked to verify (D-33). Defaults to `confirmed`. */
export type FindingVerdict = (finding: Finding) => { verdict: 'confirmed' | 'disputed'; cost?: Cost };

/** How the scripted Writer writes a chapter (P13: a draft competes, it does not overwrite). */
export interface CrewBehaviour {
    /**
     * A probe round files nothing by default — a clean round is what L-37's condition 3 is testing for.
     * Set this to make the probe come back WITH something at the given cost (D-35b's widening test).
     */
    probeFinds?:
        | { cost: Cost; title: string; criterion?: string }
        | ((round: number) => { cost: Cost; title: string; criterion?: string } | undefined);
    /** The Editor's verdict on each finding it verifies (W4e: the disputed false positive). */
    verdictFor?: FindingVerdict;
    /**
     * T6/R2d: does the scripted Editor's `verify_findings` run REPORT at all? `'report'` (default) is
     * the normal thread: one `verifyFinding` call per finding. `'silent'` closes the run with NO tool
     * call — the no-decision/no-report answer a real provider produces when the model answers prose —
     * which is the only input that exercises the loop's bound on repeated verification.
     */
    verifyReports?: 'report' | 'silent';
    /** The Critic's independent confirmation of an Editor-approved finding (default `confirm`). */
    criticConfirm?: 'confirm' | 'dispute';
    /** Ideas the verify-ideas job confirms or refutes; default `verified`. */
    ideaVerdict?: 'verified' | 'refuted';
    /**
     * D-51: the research decision the scripted EDITOR writes into the Seed Brief. It drives both
     * paths, so a test cannot get one and not the other: `seedPhase1Structure` (the seeded state) and
     * the live `structure_seed` tool call. The three states are the tool's three states —
     * `undefined` OMITS the field (the pre-D-51 shape, which still needs research), `[]` WAIVES the
     * research leg, and a non-empty list dispatches the Researcher with exactly these questions.
     */
    researchQuestions?: string[];
    /**
     * D-51: what the scripted RESEARCHER does on a `research` job. `'knowledge'` (the default) records
     * the two scripted entries, which is what every existing phase-① fixture expects. `'report'` answers
     * `reportNoResearch` with ZERO writes — the pass that concludes the premise needs no facts outside
     * itself — so a test can pin the loop's reaction to a closed-but-empty research run (the run must
     * still count as a report, S-4's `no_op: false`).
     */
    researchCalls?: 'knowledge' | 'report';
    /**
     * Findings the READER files every pass (W4d and the drain rows). Absent means the book is clean,
     * which is what lets a Story drain at all in a test that is about something else.
     */
    readerFinds?: Array<{ cost: Cost; title: string; criterion?: string }>;
    /**
     * G1 — what the phase-① DEEP-REVIEW Critic files (§6.4 step 6, D-30). Absent means the review is
     * clean, which is what every existing phase-① fixture assumes and what lets a Story install a
     * Summary with nothing to fix.
     *
     * This is a SEPARATE knob from `readerFinds` on purpose: `check_unit` with `roleName: 'critic'` is
     * the deep review of the SELECTED revision (a tool-carrying Critic), while the reader's rows belong
     * to the chapters' consistency pass (D-30's angles). One knob for both would arm a Summary round
     * every time a test scripts a reader defect.
     *
     * The function form receives the draft under review, so a row can file a DIFFERENT cost per
     * accepted revision — which is how a G1 row walks the plateau (3 revisions that do not lower the
     * blocking count) and how the dial rows prove a `minor` inside `auto_approve` counts while a taste
     * note never does (`records.ts:summaryBlockingCost`).
     *
     * WHY THE ARGS LOOK LIKE THIS: `raiseFinding` is the REAL tool here (the rig doubles only
     * `editChapter`/`selectRevision`), so the call must satisfy its guards or the run silently files
     * nothing — a phase-① finding on the Summary must name the CARRIED revision in `related_refs`
     * (T6/R2c), and a Critic finding must carry `detail` (D-30). The default title names the revision
     * because the tool's fingerprint is `target|criterion|title` (D-16): a title that varied only in
     * prose would let a re-sighting dedupe into the previous revision's row and the audit would count
     * nothing for it.
     *
     * THE GROUP MODEL'S SHAPE (D-67): on a `summary_mode: 'groups'` book the deep review claims
     * `wi_group_check_<vector>_<pass>` and has NO `revisionRef` — the artifact is the composed Overview
     * — and `tools/reader.ts:raiseFinding` then REQUIRES `group_refs` and drops the `related_refs` rule
     * (R3 scopes a Summary finding by group, not by draft). So the rig files `group_refs` for that
     * seat: every group the item carries by default (a whole-Overview defect names all five), narrowed
     * by `groupKeys` when a row wants a defect on ONE section. `groupIds` in the callback input is the
     * same list, and `pass` is read off the seat's own key family. Absent means the pass files NOTHING,
     * which is the case the Clean stamp exists for: the review closes with no unresolved defect and
     * `phrase/reviewed.ts:stampCleanRevisions` marks the vector's rows clean.
     *
     * `kind` is the claim TYPE the row is filed as, and it is here for D-33c's sake: the rule that
     * refuses a `proposal` while an issue is open reads the ROW's `kind`, so a regression that pins it
     * has to file a proposal through the REAL `raiseFinding` tool, not seed one. Absent means the call
     * carries no `kind`, which is every existing fixture and the legacy `issue` reading
     * (`tools/reader.ts:kindOf`).
     */
    deepReviewFinds?:
        | { cost: Cost; criterion?: string; title?: string; groupKeys?: string[]; kind?: 'issue' | 'proposal' }
        | ((input: {
              item: WorkItem;
              revisionId: string;
              pass: number;
              groupIds: string[];
          }) => { cost: Cost; criterion?: string; title?: string; groupKeys?: string[]; kind?: 'issue' | 'proposal' } | undefined);
    /**
     * What a `sample_unit` run answers (§6.4 step 3). The default derives the six prose fields from
     * the Seed Brief the compiled prompt carries, so the installed Summary provably came from the
     * round's prompt. Return a STRING to answer with raw text instead — an invalid JSON answer is how
     * the retry-cap and re-arm rows are driven (`"not json"` twice = a failed sample).
     */
    sampleAnswer?: (input: { item: WorkItem; sampleIndex: number; prompt: string }) => SummarySample | string;
    /**
     * What a `screen_samples` run answers (§6.4 step 4). Default `{issues: []}` — a clean draft.
     * `revisionId` is the draft being screened, so a test can make ONE sample lose on a canned
     * critical issue while its siblings stay clean (`selectSample`'s ranking, §6.5).
     */
    screenAnswer?: (input: { item: WorkItem; revisionId: string; prompt: string }) => IssueList | string;
    /**
     * H1/R2 — the certificate a `screen_samples` run returns for the fix tasks its job carried
     * (`WorkItem.fixRefs`). The default marks every one `resolved` with a quotation, because the rig
     * is a cooperative model: what a loop test exercises is the ENGINE's reaction to a certificate —
     * the hill-climb retry, the rejected candidate, the closure gate — not the model's ability to
     * write one. Return `[]` for a pass that ignored the FIX TASKS section, or an `unresolved` entry
     * to throw one candidate off the round (`loop/sample-select.ts:scoreSample`).
     */
    screenFixes?: (input: {
        item: WorkItem;
        revisionId: string;
        prompt: string;
        fixIds: string[];
    }) => SampledFixVerification[];
    /**
     * What a `draft_groups` run answers (R2 — the Summary Phrase's per-group Writer). The default
     * writes ONE phrase per targeted group, worded so a test can tell which group a Group Revision
     * came from; the hook is how a test scripts a REFUSED answer — an unknown group id, a group the
     * Work Item was never dispatched for, prose that is not JSON.
     */
    groupDraft?: (input: { item: WorkItem; groupRefs: string[]; prompt: string }) => GroupDraft | string;
    /**
     * PHRASE ② (T-W2) — what a chapter lane's `draft_groups` run answers. SAME Work Item kind as
     * `groupDraft`, different contract: the job's `response_format.name` is `ChapterDraft`, and the answer
     * carries PLOTPOINTS (`must_happen`/`must_change`, plus the optional heading/pov/setups/payoffs)
     * because a chapter entry is a contract, not prose. The default names exactly the group refs the Work
     * Item carried, so `phrase/plotpoints.ts:parseChapterDraftAnswer` accepts the batch; the hook is how a
     * test scripts a thin answer (a blank `must_happen`), an id outside the phrase, or prose that is not
     * JSON — all three of which refuse the whole install (R2's atomicity, one phrase down).
     */
    chapterDraft?: (input: { item: WorkItem; groupRefs: string[]; prompt: string }) => ChapterDraft | string;
    /**
     * What a `review_groups` run answers (the gate that decides whether a group draft becomes
     * current). Default: clean. The hook is how a test files GROUP-SCOPED issues, which is the only
     * way R3's multi-group closure gets driven end to end: an issue naming two groups stays open
     * until BOTH groups have a resolving revision.
     */
    groupReview?: (input: { item: WorkItem; groupRefs: string[]; prompt: string }) => GroupReview | string;
    /**
     * What a `score_sections` run answers (D-65 — the Reader's display-only section scores). The default
     * scores every group the Work Item carried, in that order, at `60 + 8 × position` — the same numbers
     * `integration/harness.ts:defaultSectionScoreAnswer` gives the full-server slices, so a score pinned
     * in one mock reads identically in the other.
     *
     * The hook is how a test drives the REFUSAL path: return a partial answer (a section missing), an
     * out-of-range score, or prose that is not JSON, and `phrase/section-scores.ts:parseSectionScoreAnswer`
     * refuses the whole thing — which `loop/engine.ts:settleJob` answers by writing NO rows at all.
     */
    sectionScores?: (input: { item: WorkItem; groupRefs: string[]; prompt: string }) => SectionScores | string;
    /**
     * What a `group_lock` run answers (R3/T6b — the Editor's judgement on ONE section of the clean
     * Overview, offered only when `story.editor_group_locking` is on). Default: lock it, with a rationale
     * naming the section, because a seat is only ever armed when the book already allows the freeze
     * (Setting, clean vector, Reader row, no Writer hold) — so the flag is the outcome a default-driven
     * test asserts, and the flag is what `phrase/locks.ts:lockPhraseGroup` writes.
     *
     * The hook is how a test drives every other outcome: `{ lock: false }` (the section stays unlocked and
     * the seat is STILL spent — a decision, not a failure), a blank `rationale` (the contract refuses and
     * nothing is written), an answer naming a different `group_ref` (refused rather than re-attributed), or
     * prose that is not JSON. A guard refusal is driven from outside the mock instead — flip the Setting or
     * install a Writer between the claim and the settle, and `editorLockGuardReason` answers inside the
     * commit.
     */
    groupLock?: (input: { item: WorkItem; groupRefs: string[]; prompt: string }) => GroupLockDecision | string;
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

export interface RigOptions {
    /** S-5's ceiling. The default is 1 so the chat double always knows which run it is answering. */
    globalMaxConcurrent?: number;
    /** Passed to `LoopEngine.createStory`, plus the §15 step-0 fields. */
    story?: { title?: string; idea?: string; chapter_count?: number; auto_approve?: Cost[] };
    /** D-17d/D-38a: rewrite the assigned Writer templates' `attempts` before the first sweep. */
    attempts?: number;
    /** Phase ① sampling size for this rig's Story (default 1: the rig is the clock, not the product). */
    summarySampling?: number;
    /** Phase ① Critic passes per sample for this rig's Story (default 1, same reason). */
    summaryCritics?: number;
    /**
     * SUMMARY PHRASE R1/R6 — which phase-① pipeline this rig's Story runs (default `'sampling'`).
     *
     * WHY THE RIG DEFAULT IS THE LEGACY VALUE: the whole existing loop suite (hill-climb, sampling
     * progress, screening, selection, escalation) is written against whole-Summary sampling, and the
     * redesign's switch is a Story SETTING rather than a derived fact. `'sampling'` puts those rigs
     * exactly where they were; `summaryMode: 'groups'` is how a Summary Phrase test asks for the five
     * catalog groups, the per-group Writer batch and the install-instead-of-select settlement. The real
     * `createStory` default stays `'groups'` — the rig is a test fixture, not the product.
     */
    summaryMode?: 'groups' | 'sampling';
    /** The crew's scripted behaviour (above). */
    crew?: CrewBehaviour;
    /**
     * The Seed is already STRUCTURED and RESEARCHED (default true): an accepted `SeedBrief` for the
     * current Seed and a closed `wi_research_<brief.rev>` run, so a rig that is about the sampling
     * pipeline starts at its first sample. Set false to watch `structure_seed` and `research` gate
     * the first sample (§6.4 steps 1-2).
     */
    seedStructured?: boolean;
    /** Extra tool overrides, on top of the rig's two (a test that wants a refusing tool). */
    tools?: Record<string, MockToolHandler>;
    /** `flat_rounds` / `regress_tolerance` overrides for the stall rows (L-21). */
    goal?: { flat_rounds?: number; regress_tolerance?: number; threshold_soft?: number };
    /** Skip the Digest row (the engine rebuilds it, D-12a — the row's absence is the interesting case). */
    noDigest?: boolean;
    /** Lease window (S-4a) for the lapse test. */
    leaseIdleMs?: number;
    /**
     * Attach a store the caller built — usually `await Store.load(dir)` for W5's restart row, where the
     * point of the test is that a SECOND engine reads what the first one wrote (L-3).
     */
    store?: Store;
    /**
     * Use the store's existing Story instead of creating one. Paired with `store`, this is the restarted
     * loop: the rows, the claim keys and the journal are the state, so nothing has to be handed over.
     */
    attach?: boolean;
}

/** Everything a loop test needs, in one object. */
export interface Rig {
    store: Store;
    engine: LoopEngine;
    executor: RunExecutor;
    runtime: MockToolRuntime;
    /** The chat double's request log — S-2/E-1 assertions read the brief a run was actually given. */
    requests: ChatRequest[];
    /** Every Work Item the engine dispatched, in dispatch order, keyed by claim key. */
    items: Map<string, WorkItem>;
    storyId: string;
    /** `sweep()` then `settle()`: the state a real loop reaches between two sweeps. */
    step(): Promise<SweepReport>;
    /** Sweep until the Story stops changing or `max` sweeps pass, whichever comes first. */
    run(max?: number): Promise<SweepReport[]>;
    /** The Story row, fresh. */
    story(): Story;
    /** The live run rows (S-3: a closed run is not live). */
    liveRuns(): string[];
}

/** Seeds `chapter_count` plotlines so C-0/C-1 have a chance to pass (the §8 catalogue has no plotline tool). */
export const seedPlotlineSet = (store: Store, storyId: string, count: number) => {
    for (let order = 1; order <= count; order += 1) {
        seedPlotline(store, storyId, {
            order,
            heading: `plotline ${order}`,
            must_happen: `the map fails in plotline ${order}`,
            must_change: `she stops trusting the map at ${order}`,
            pov: 'Maren',
            setups: `the 1911 survey map (${order})`,
            payoffs: `the steeple bell (${order})`
        });
    }
};

/**
 * The Seed Brief the scripted Editor derives, shared by the live `structure_seed` answer and by
 * `seedPhase1Structure` so the two paths cannot drift: a test that runs the Editor's pass and a test
 * that seeds the finished state assert against ONE set of values.
 *
 * The values are deliberately generic placeholders — the rig is a clock, not a prose generator — but
 * they claim nothing the Seed does not (`logline` IS the Seed's first line), so a test asserting
 * `sample 1: <logline>` proves the sampler's prompt carried this brief.
 *
 * D-51's three states for `researchQuestions`: `undefined` (the default) OMITS the field, which is
 * the shape every pre-D-51 fixture had and which `records.ts:researchGate` reads as `needed`; `[]` is
 * the Editor's WAIVER; a non-empty list is the dispatch decision, with the questions on the record.
 */
const scriptedBriefFields = (seed: string, researchQuestions?: string[]) => ({
    logline: seed.split('\n')[0]?.trim() ?? seed,
    protagonist: 'the protagonist the Seed names',
    want: 'what the Seed says they pursue',
    obstacle: 'what the Seed puts in the way',
    stakes: 'what the Seed says is lost',
    setting: 'the place the Seed names',
    world_rules: ['the Seed is law (P5)'],
    promise: 'the book pays the promise the Seed makes',
    tone_hints: 'as the Seed tells it',
    constraints: [] as string[],
    open_questions: [] as string[],
    ...(researchQuestions === undefined ? {} : { research_questions: researchQuestions })
});

/**
 * D-51: does this scripted decision WAIVE the research leg? Only an explicit empty list does —
 * `undefined` keeps the legacy "field predates D-51" shape, which still needs the pass.
 */
const waivesScriptedResearch = (researchQuestions?: string[]): boolean =>
    researchQuestions !== undefined && researchQuestions.length === 0;

/**
 * The state a finished `structure_seed` + `research` pass leaves behind (§6.4 steps 1-2): an
 * ACCEPTED `SeedBrief` whose `seed_hash` is the current Seed's, and a CLOSED run for the brief's
 * research key, which is exactly what `records.ts:researchClosed` reads.
 *
 * The brief's fields are deliberately derived from the Seed's first line so a test can prove the
 * sampler's prompt carried THIS brief (`premise: sample 1: <logline>` comes back through the mock's
 * default sample answer). No `knowledge` row is seeded: the compiled prompt's KNOWLEDGE block is
 * optional by design (§5 omits an empty section), and a test that wants one can seed it.
 *
 * D-51: pass `researchQuestions: []` for a brief that WAIVES the research leg — then NO research run
 * is seeded, because a waived brief never has a research Work Item to close. The default (`undefined`)
 * keeps the pre-D-51 shape exactly: a brief without the field plus a closed research run.
 */
export const seedPhase1Structure = (store: Store, storyId: string, researchQuestions?: string[]): void => {
    const story = store.stories.require(storyId);
    const at = new Date().toISOString();

    const brief = store.seedBriefs.create(
        {
            story_id: storyId,
            seed_hash: seedHashOf(story.idea),
            ...scriptedBriefFields(story.idea, researchQuestions),
            status: 'accepted'
        },
        { run_ref: null, why: 'seed: the Editor accepted a Seed Brief for the current Seed (§6.4 step 1)' }
    );

    // The waiver means "no Researcher, ever, for this brief" — seeding a closed run for it would hide
    // the very thing a D-51 test asserts (that no `wi_research_*` row is ever generated).
    if (waivesScriptedResearch(researchQuestions)) return;

    store.runs.create(
        {
            story_id: storyId,
            work_item_ref: researchKeyOf(brief),
            role: 'researcher',
            state: 'torn_down',
            started_at: at,
            ended_at: at,
            tokens: 0,
            kind: 'work',
            no_op: false,
            delegated: []
        },
        { run_ref: null, why: 'seed: the research pass for the accepted Seed Brief already closed (§6.4 step 2)' }
    );
};

/**
 * Walks the rig to the START of `phase`, taking the sign-offs the walk passes (§15 steps 1-5). The
 * plotline rows have to be seeded by hand because §8's catalogue gives no agent a way to create one —
 * the gap W2 reports — and phase ② cannot pass C-0/C-1 without them.
 */
export async function walkTo(rig: Rig, phase: 'plotlines' | 'chapters', plotlines = 1): Promise<void> {
    await rig.run();

    if (phase === 'plotlines') return;

    await rig.engine.lockPhase(rig.storyId, 'summary');
    seedPlotlineSet(rig.store, rig.storyId, plotlines);
    await rig.run();

    if (phase === 'chapters') await rig.engine.lockPhase(rig.storyId, 'plotlines');
}

/**
 * Walks the rig to the START of phase ③, taking the two sign-offs the walk passes (§15 steps 1-5).
 * Two plotlines are seeded by default because phase ②'s C-0/C-1 have nothing to pass otherwise.
 */
export async function walkToChapters(rig: Rig, plotlines = 2): Promise<Rig> {
    await rig.run();
    await rig.engine.lockPhase(rig.storyId, 'summary');
    seedPlotlineSet(rig.store, rig.storyId, plotlines);
    await rig.run();
    await rig.engine.lockPhase(rig.storyId, 'plotlines');

    return rig;
}

/**
 * Walks the rig all the way to the drained boundary: phase ③ finished, the whole-Story pass behind it,
 * a clean probe round, `pending`/`drained` (§15 steps 1-10). The stall and drain tests start here
 * because both are about what happens AFTER the book has been looked at once.
 */
export async function walkToDrain(rig: Rig, plotlines = 2): Promise<Rig> {
    await walkToChapters(rig, plotlines);
    await rig.run();

    return rig;
}

/** The §15 step-0 rig: a real store, a real engine, a scripted crew, one Story in phase ①. */
export async function createRig(options: RigOptions = {}): Promise<Rig> {
    const store = options.store ?? Store.empty();
    const criteria = new CriteriaEngine();
    const digest = new DigestBuilder();

    // The Work Items the engine hands the executor. The rig remembers them because the store keeps only
    // the claim key (`runs.work_item_ref`), and the chat double needs the whole job to answer.
    const items = new Map<string, WorkItem>();
    const requests: ChatRequest[] = [];

    // Built in dependency order, and wired by hand: `RunExecutor`'s deps are pinned by T5
    // (`{store, runtime, chat, defaultModel}`), and the chat double has to exist before the executor can
    // answer a turn. The two placeholders below are replaced by `Object.assign` in the same tick, before
    // anything can run — `RunExecutor`'s fields are `private readonly` to TypeScript only.
    const executor = new RunExecutor({
        store,
        runtime: undefined as unknown as MockToolRuntime,
        chat: undefined as unknown as MockChatClient,
        defaultModel: 'mock-gpt'
    });

    // `execute` is patched to remember the job (P1: the rig reads the store, and the store keeps the
    // claim key, not the job). The real executor still does all the work.
    const execute = executor.execute.bind(executor);

    executor.execute = (item: WorkItem, signal?: AbortSignal) => {
        items.set(item.id, item);

        return execute(item, signal);
    };

    // How many chat turns each Work Item has had. A run answers with its tool calls on the first turn and
    // with prose on the second, which is what ends it (S-1: one job, one harness, then teardown).
    const acted = new Set<string>();

    const handler: MockHandler = (request) => {
        requests.push(request);

        return answerCrew(store, items, acted, request, options.crew ?? {});
    };

    const chat = new MockChatClient(handler);
    const runtime = new MockToolRuntime(store, '', crewTools(options.crew ?? {}));

    Object.assign(executor, { runtime, chat });

    const engine = new LoopEngine({
        store,
        executor,
        criteria,
        digest,
        config: {
            globalMaxConcurrent: options.globalMaxConcurrent ?? 1,
            leaseIdleMs: options.leaseIdleMs,
            // Tests drive every sweep; the timer would only add a clock to a deterministic test (L-1).
            autoSweep: false
        } satisfies LoopEngineConfig
    });

    // `attach` is W5's restart row: the second engine must not create a Story, because the whole claim of
    // L-3 is that the rows the first engine wrote ARE the state it resumes from.
    let storyId: string;

    if (options.attach === true) {
        const existing = store.stories.list()[0];

        if (existing === undefined)
            throw new Error('createRig({ attach: true }) needs a store that already holds a Story');

        storyId = existing.id;
    } else {
        const created = await engine.createStory({
            title: options.story?.title,
            idea: options.story?.idea,
            chapter_count: options.story?.chapter_count ?? 1,
            auto_approve: options.story?.auto_approve,
            // The loop rig exercises the pipeline, not the sample count: one Writer and one
            // Critic keeps each sweep deterministic and cheap. The product's standards (5/5)
            // are the Story defaults and are pinned against the real server.
            summary_sampling: options.summarySampling ?? options.attempts ?? 1,
            summary_critics: options.summaryCritics ?? 1,
            // R1/R6: the rig keeps the pre-redesign pipeline unless a Summary Phrase test asks for the
            // group one, so the existing loop suite is unaffected by the new product default.
            summary_mode: options.summaryMode ?? 'sampling'
        });

        storyId = created.story_id;
    }

    // Phase ①'s two opening stages. The rig seeds them CLOSED by default so a test that is about
    // sampling (or about phases ②/③, which walks through phase ①) starts where it means to;
    // `seedStructured: false` leaves both un-run and lets the sweep dispatch the Editor's
    // `structure_seed` and then the Researcher's `research` (§6.4 steps 1-2).
    //
    // D-51: `crew.researchQuestions` is the scripted Editor's research decision, and the SAME value
    // drives the seeded state and the live tool call — `[]` seeds a WAIVED brief with no research run,
    // so a waived Story starts straight at sampling.
    if (options.attach !== true && options.seedStructured !== false)
        seedPhase1Structure(store, storyId, options.crew?.researchQuestions);

    // L-1's switch is ON for every rig: `start()` with `autoSweep: false` means "the loop is running, and
    // the test is the clock". A stopped engine refuses every sweep (L-1), which is W5's stop test, not the
    // default — and the restarted engine of the `attach` row starts exactly the same way (L-3).
    engine.start();

    // The tool runtime is Story-scoped (T-3), and one instance serves every run in the rig.
    Object.assign(runtime, { storyId });

    if (options.attempts !== undefined) {
        for (const template of store.templates.list().filter((row) => row.name.startsWith('writer-'))) {
            store.templates.update(
                template.id,
                { attempts: options.attempts },
                { run_ref: null, author: true, why: 'the Author set the divergence count (D-17d)' },
                [{ id: template.id, rev: template.rev }]
            );
        }
    }

    if (options.goal !== undefined) {
        const goal = store.goals.list().find((row) => row.story_id === storyId);

        if (goal !== undefined) {
            store.goals.update(
                goal.id,
                {
                    flat_rounds: options.goal.flat_rounds ?? goal.flat_rounds,
                    regress_tolerance: options.goal.regress_tolerance ?? goal.regress_tolerance,
                    threshold_soft: options.goal.threshold_soft ?? goal.threshold_soft
                },
                { run_ref: null, author: true, why: 'the Author set the stall counters (G-1, L-21)' },
                [{ id: goal.id, rev: goal.rev }]
            );
        }
    }

    // An attached store already carries its Digest row; seeding a second one would put two `current`
    // rows in the collection and turn a restart test into a fixture bug.
    if (options.noDigest !== true && options.attach !== true)
        seedDigest(store, storyId, 'Maren reaches the ridge; the valley is water.', true);

    const rig: Rig = {
        store,
        engine,
        executor,
        runtime,
        requests,
        items,
        storyId,
        async step() {
            const report = await engine.sweep();

            await engine.settle();

            return report;
        },
        async run(max = 40) {
            const reports: SweepReport[] = [];

            for (let index = 0; index < max; index += 1) {
                const before = JSON.stringify(snapshot(store, storyId));

                reports.push(await rig.step());

                if (JSON.stringify(snapshot(store, storyId)) === before) break;
            }

            return reports;
        },
        story: () => store.stories.require(storyId),
        liveRuns: () =>
            store.runs
                .list()
                .filter((run) => LIVE_RUN_STATES.includes(run.state))
                .map((run) => run.id)
    };

    return rig;
}

/** The state a sweep can change — the equality `rig.run()` uses to decide the Story has settled. */
function snapshot(store: Store, storyId: string) {
    const pick = <T extends { id: string; rev: number }>(rows: T[]) =>
        rows
            .filter((row) => (row as { story_id?: string }).story_id === storyId)
            .map((row) => `${row.id}@${row.rev}`)
            .sort();

    return {
        story: store.stories.require(storyId),
        chapters: pick(store.chapters.list()),
        findings: pick(store.findings.list()),
        tasks: pick(store.tasks.list()),
        verdicts: pick(store.verdicts.list()),
        revisions: pick(store.revisions.list()),
        ideas: pick(store.ideas.list()),
        runs: store.runs.list().map((run) => `${run.id}@${run.state}`)
    };
}

// ---------------------------------------------------------------------------
// The crew
// ---------------------------------------------------------------------------

/** Every criterion id the brief names — what a reader reports on (D-15: the brief IS the criteria). */
function criteriaNamed(text: string): string[] {
    return [...new Set(text.match(/\bC-\d+\b/g) ?? [])].sort();
}

/**
 * The reader's per-criterion report (D-15: one line per criterion the brief named).
 *
 * Everything passes EXCEPT the criteria the test's `readerFinds` name — which is how the rig models a
 * real book: a reader can file a `minor` defect while the unit still passes its Goal (a soft criterion
 * failing leaves `soft_count` above `threshold_soft`, so `chapterGoalStatus` stays green). Tying every
 * verdict to the presence of a finding, as an earlier draft did, made any finding block the phase Goal
 * and no Story could ever drain.
 */
function verdictLines(
    ids: string[],
    finds: Array<{ criterion?: string }> = []
): Array<{ criterion: string; result: boolean; evidence: string }> {
    return ids.map((criterion) => ({
        criterion,
        result: !finds.some((finding) => finding.criterion === criterion),
        evidence: finds.some((finding) => finding.criterion === criterion)
            ? 'the reader saw it on the page'
            : 'the unit delivers what this criterion asks for'
    }));
}

/**
 * What one run answers, given the Work Item it is running.
 *
 * The Work Item is recovered from the live run rows: `runs.work_item_ref` is the claim key, and the rig
 * remembers the job that key was built from. With S-5's ceiling at 1 there is exactly one live run, so
 * the mapping is unambiguous; with a wider ceiling the brief's unit ref breaks the tie (E-1: the brief
 * always names the artifact it is about).
 */
function answerCrew(
    store: Store,
    items: Map<string, WorkItem>,
    acted: Set<string>,
    request: ChatRequest,
    crew: CrewBehaviour
): ChatResponse {
    const text = request.messages.map((message) => message.content).join('\n');
    const live = store.runs.list().filter((run) => LIVE_RUN_STATES.includes(run.state));
    const candidates = live
        .map((run) => ({ run, item: items.get(run.work_item_ref ?? '') }))
        .filter((entry): entry is { run: (typeof live)[number]; item: WorkItem } => entry.item !== undefined);

    // §6.4 steps 3-4: a no-tool run asks for a SCHEMA-CONSTRAINED answer, not for tool calls, so it
    // is answered before the tool-call machinery below and never joins the `acted` set — the one
    // schema-repair retry must receive a real answer again, not the prose that ends a tool run.
    if (request.responseFormat !== undefined)
        return { message: msg({ content: structuredAnswer(store, items, request, crew) }) };

    const chosen =
        candidates.find(
            (entry) => entry.item.unit !== undefined && entry.item.unit.ref !== '' && text.includes(entry.item.unit.ref)
        )?.item ?? candidates[candidates.length - 1]?.item;

    if (chosen === undefined) return { message: msg({ content: 'no live Work Item to answer for' }) };

    if (acted.has(chosen.id)) return { message: msg({ content: `reported: ${chosen.kind}` }) };

    acted.add(chosen.id);

    const wanted = crewCalls(store, chosen, text, crew);

    if (wanted.length === 0) return { message: msg({ content: `nothing to report on ${chosen.kind}` }) };

    return { message: msg({ content: `doing ${chosen.kind}`, toolCalls: calls(wanted) }) };
}

/** The tool calls one job makes — the scripted half of every job in §6.2's three loops. */
function crewCalls(store: Store, item: WorkItem, text: string, crew: CrewBehaviour): ScriptCall[] {
    const isProbe = (item.note ?? '').includes('probe round');

    if (isProbe) {
        // The drain probe's whole job is to answer "is anything left at the dial?" (L-37.3). A clean round
        // files nothing; `probeFinds` is the widened-dial case (D-35b).
        // Which defect this round turns up. A fixed spec re-files the SAME fingerprint every round,
        // which D-16 dedupes — and a round that files nothing new is a clean round (L-37.3). The
        // function form varies the title by round, which is how the stall tests keep the rounds dirty
        // (L-21's flat streak needs rounds that keep being judged, not a Story that has run out).
        const round = Number(/round (\d+)/.exec(item.note ?? '')?.[1] ?? '1');
        const spec = typeof crew.probeFinds === 'function' ? crew.probeFinds(round) : crew.probeFinds;

        if (spec === undefined) return [];

        const unit = item.unit;

        return [
            {
                name: 'raiseFinding',
                args: {
                    target_ref: unit?.ref ?? item.storyId,
                    criterion_ref: spec.criterion ?? 'C-4',
                    title: spec.title,
                    detail: `The probe round found ${spec.title} in ${unit?.ref ?? item.storyId}.`,
                    evidence: `the probe round saw it: ${spec.title}`,
                    cost: spec.cost
                }
            }
        ];
    }

    switch (item.kind) {
        // §6.4 step 1: the Editor derives the brief from the Seed and writes it ONCE. `structureSeed`
        // (the W5 double) refuses a `seed_hash` that does not match the Seed, so the answer sends the
        // hash the record holds — the same guard the real tool applies (P5).
        //
        // F2 — THE WRITE BELONGS TO THE PHRASE THAT OWNS THE SEAT. Both structuring passes share the
        // `structure_seed` KIND (`loop/work.ts:1618` arms Phrase ②'s chapter pass with it), and the seat is
        // the CLAIM-KEY FAMILY (`loop/records.ts:PLOTLINES_STRUCTURE_ITEM_PREFIX`). Answering Phrase ②'s
        // seat with `structureSeed` was not a cosmetic slip: it SUCCEEDS, writing a `seed_briefs` row for
        // the OTHER phrase, so a probe run of the lane spent 40 runs and produced ZERO Plotline Briefs
        // (`Temp/c4`'s report), the chapter set never existed, no-op accounting saw no reason to complain,
        // and no mock-driven test ever exercised the path the lane was built on. `structurePlotlines` (the
        // handler is below, in `crewTools`) is the write this seat owes: it declares `chapter_count` and
        // materializes `chapter_1..chapter_N` in the same commit (D-3b).
        case 'structure_seed': {
            if (item.id.startsWith(PLOTLINES_STRUCTURE_ITEM_PREFIX)) {
                const phraseStory = store.stories.get(item.storyId);
                const phrase =
                    phraseStory === undefined
                        ? undefined
                        : storyPhraseByKey(store, item.storyId, PHRASE_PLOTLINES_KEY);
                // THE COUNT IS THE AUTHOR'S (D-3b, and the seat's own job sentence): the mock honours the
                // number on the Summary row rather than inventing one, so a rig that declared 3 chapters
                // gets a 3-entry chapter set out of this call.
                const declared =
                    phraseStory === undefined
                        ? undefined
                        : store.summaries.list().find((row) => row.story_id === phraseStory.id)?.chapter_count;

                return [
                    {
                        name: 'structurePlotlines',
                        args: {
                            seed_hash: seedHashOf(phraseSeedOf(phrase, phraseStory)),
                            chapter_count:
                                typeof declared === 'number' && declared > 0 ? Math.trunc(declared) : 1,
                            notes: 'one chapter per commitment the phrase seed states (the scripted Editor)',
                            why: 'the chapter set is what this phrase seed resolves into (P5 one phrase down, D-3b)'
                        }
                    }
                ];
            }

            const seed = store.stories.get(item.storyId)?.idea ?? '';

            return [
                {
                    name: 'structureSeed',
                    args: {
                        seed_hash: seedHashOf(seed),
                        // D-51: the scripted Editor states its research decision with the brief, exactly
                        // as the real tool requires; `undefined` keeps the pre-D-51 arg shape.
                        ...scriptedBriefFields(seed, crew.researchQuestions),
                        why: 'the brief restates the Seed and invents nothing (P5, D-17c)'
                    }
                }
            ];
        }

        // §6.4 step 2: the Researcher records the facts the brief depends on, with sources (T-10).
        // Two entries — one `critical`, one `high` — so the compiled prompt's KNOWLEDGE block has a
        // ranked list to render and a test can prove both importances reach the sampler.
        //
        // D-51's other answer: `researchCalls: 'report'` closes the same job with `reportNoResearch`
        // and ZERO writes, which is the dispatched-pass-that-needs-nothing case. The run must still
        // count as a report (S-4), and the gate must close so the next work is sampling.
        case 'research':
            if (crew.researchCalls === 'report')
                return [
                    {
                        name: 'reportNoResearch',
                        args: {
                            rationale:
                                'the Seed states every fact this story depends on, and readKnowledge holds nothing that contradicts it',
                            why: 'the pass read the brief and the knowledge and found no fact to establish (D-51)'
                        }
                    }
                ];

            return [
                {
                    name: 'writeKnowledge',
                    args: {
                        topic: 'period and place',
                        kind: 'place',
                        claim: 'the Seed names the place the story happens in',
                        detail: 'the Seed is the only source here; the detail is what the Seed states, nothing invented',
                        importance: 'critical',
                        sources: [
                            {
                                url_or_title: 'the Author\u2019s Seed',
                                claim: 'it names the story\u2019s setting',
                                accessed_at: '2000-01-01T00:00:00.000Z'
                            }
                        ],
                        why: 'the sampler needs the place it is writing about (T-10)'
                    }
                },
                {
                    name: 'writeKnowledge',
                    args: {
                        topic: 'governing rule',
                        kind: 'world_rule',
                        claim: 'the world holds to the promise the Seed makes',
                        detail: 'the Seed is law (P5)',
                        importance: 'high',
                        sources: [
                            {
                                url_or_title: 'the Author\u2019s Seed',
                                claim: 'it makes the book\u2019s promise',
                                accessed_at: '2000-01-01T00:00:00.000Z'
                            }
                        ],
                        why: 'the sampler must not contradict the promise the Seed makes'
                    }
                }
            ];

        case 'write_unit': {
            const unit = item.unit;

            if (unit === undefined || unit.kind !== 'chapter') {
                // Phases ① and ② edit the artifact in place; the catalogue has no plotline tool (a W2 gap
                // this rig reports rather than papers over).
                return [{ name: 'editSummary', args: { premise: 'The map and the territory reconcile.' } }];
            }

            const chapter = store.chapters.get(unit.ref);

            if (chapter === undefined) return [];

            // P13/D-21: the Writer drafts. The tool override turns this call into a COMPETING revision, so
            // the divergence count (D-17d) is visible in the store as revisions, not in memory.
            return [
                {
                    name: 'editChapter',
                    args: {
                        chapter_id: chapter.id,
                        sections: [
                            { id: 'sec_1', text: chapter.sections[0]?.text ?? '', origin: 'author' },
                            {
                                id: 'sec_2',
                                text: `draft ${item.id}: ${chapter.title} delivers its contract`,
                                origin: 'writer'
                            }
                        ]
                    }
                }
            ];
        }

        case 'check_unit':
        case 'whole_story_check': {
            // The brief's ROLE section names criteria in prose (a Critic prompt names the
            // critic-visible ones), so filtering the WHOLE brief over-reports. A Critic review
            // reports the criteria the PHASE briefing lists; a reader's existing whole-brief
            // read is left alone (its fixtures depend on it).
            const phaseBriefing = text.split('# PHASE AND GOAL CRITERIA')[1]?.split('\n# SEED')[0] ?? text;
            const ids = criteriaNamed(item.roleName === 'critic' ? phaseBriefing : text);
            const report: ScriptCall[] = [];
            const lines = verdictLines(ids, crew.readerFinds);
            // §4.9's recommendation enum is `advance | fix | stuck`. The rig used to answer `rework`,
            // which the tool schema (reader.ts:200 `enumOf(['advance','fix','stuck'])`) would refuse
            // from a real crew — the mock runtime does not validate, so the illegal value silently landed
            // in the verdict rows. `fix` is what the failing-criteria case means: work remains.
            const recommendation = lines.some((line) => !line.result) ? 'fix' : 'advance';

            // The draft under judgment (loop B, §6.2a): named in the job note, and filed against the
            // draft. The id in the note is a §4.15 `revision_N` (work.ts builds the note from
            // `revision.id`), so the capture must match what the store actually mints — `rev_` never
            // matched, which is why per-draft verdicts silently never landed (D-21, U-13).
            const draft = /draft ((?:revision|rev)_\w+)/.exec(item.note ?? '')?.[1];

            if (draft !== undefined) {
                report.push({
                    name: 'submitVerdict',
                    args: { target_ref: draft, target_kind: 'revision', round: 1, criteria: lines, recommendation }
                });
            }

            // Every target the phase's criteria aggregate over (criteria/engine.ts:scopeTargets): the unit
            // for a per-unit job, every chapter plus the Story for a whole-Story pass.
            for (const target of verdictTargets(store, item)) {
                report.push({
                    name: 'submitVerdict',
                    args: {
                        target_ref: target.ref,
                        target_kind: target.kind,
                        round: 1,
                        criteria: lines,
                        recommendation
                    }
                });
            }

            // `readerFinds` is the READER's knob (§4.12's consistency crew). A phase-①
            // `check_unit` job with `roleName: 'critic'` is the deep-review Critic, whose findings
            // are a different judgement (D-30's angles, filed against the selected revision), so the
            // rig must not let a reader fixture leak into the Summary review — the defect a test
            // scripts for the chapters would otherwise arm sampling rounds nobody meant to test.
            if (item.roleName !== 'critic') {
                for (const finding of crew.readerFinds ?? []) {
                    report.push({
                        name: 'raiseFinding',
                        args: {
                            target_ref: item.unit?.ref ?? item.storyId,
                            criterion_ref: finding.criterion ?? 'C-4',
                            title: finding.title,
                            evidence: `the reader saw it: ${finding.title}`,
                            cost: finding.cost
                        }
                    });
                }
            } else if (item.revisionRef !== undefined) {
                // G1 — the deep-review Critic's own knob. The pass number comes from the claim key
                // (`deepReviewKeyOf` mints `wi_review_<revision>_a<pass>`), so a row can script pass 1
                // filing and pass 2 staying clean, and `records.ts:revisionReviewFindings` attributes the
                // row to this revision's review through the run's `attribution.run_ref`.
                const revisionId = item.revisionRef;
                const spec =
                    typeof crew.deepReviewFinds === 'function'
                        ? crew.deepReviewFinds({
                              item,
                              revisionId,
                              pass: Number(/_a(\d+)$/.exec(item.id)?.[1] ?? '1'),
                              // The legacy seat reviews a DRAFT, so it has no group scope to offer; an
                              // empty list is the honest value rather than a fabricated five.
                              groupIds: []
                          })
                        : crew.deepReviewFinds;

                if (spec !== undefined) {
                    const title = spec.title ?? `Deep review: ${revisionId} leaves the Seed's promise unpaid`;

                    report.push({
                        name: 'raiseFinding',
                        args: {
                            target_ref: item.unit?.ref ?? item.storyId,
                            criterion_ref: spec.criterion ?? 'C-4',
                            title,
                            // D-30: the Critic's what-and-where line — the tool refuses without it.
                            detail: `The promise field of ${revisionId} states an obligation the rest of the draft never pays; the ending is where it stops.`,
                            evidence: `the deep-review pass read ${revisionId} against the Seed and found the promise unpaid`,
                            cost: spec.cost,
                            // D-33c reads the ROW's kind, so a fixture that wants a proposal says so here.
                            ...(spec.kind === undefined ? {} : { kind: spec.kind }),
                            // T6/R2c: a phase-① Summary defect must name the draft it describes, which is
                            // also exactly the id `findingRevisionScope` uses to keep it out of `superseded`.
                            related_refs: [revisionId],
                            why: 'The Critic angle: what a reader of this Author would object to (D-30).'
                        }
                    });
                }
            } else if ((item.groupRefs?.length ?? 0) > 0) {
                // D-67 — the GROUP model's deep review, the seat the Clean stamp hangs on. It carries
                // `group_refs` (all five, because the Critic judges the composed Overview) and NO
                // `revisionRef`, so the legacy branch above never sees it and the rig has to answer the
                // book's own shape: `group_refs` on the finding, and no `related_refs` naming a draft
                // that does not exist.
                const spec =
                    typeof crew.deepReviewFinds === 'function'
                        ? crew.deepReviewFinds({
                              item,
                              // There is no draft row to name; the seat's key IS the identity of what is
                              // under review (the vector), so a fixture that prints it stays readable.
                              revisionId: item.id,
                              // `wi_group_check_<hash>_<pass>` carries the pass at the END, with no `a`
                              // marker — the group family's own spelling, matching `groupCheckSeatKey`.
                              pass: Number(/_(\d+)$/.exec(item.id)?.[1] ?? '1'),
                              groupIds: item.groupRefs ?? []
                          })
                        : crew.deepReviewFinds;

                if (spec !== undefined) {
                    // The scope. Default is EVERY group the seat carries, because `findingGroupScope`
                    // reads an unscoped Summary finding as "all five" and the tool refuses an empty
                    // `group_refs` on a grouped book anyway; `groupKeys` narrows it to the sections a
                    // row is actually about, which is how a test stamps three groups clean and leaves
                    // two open.
                    const owned = store.phraseGroups
                        .list()
                        .filter((group) => group.story_id === item.storyId)
                        .sort((left, right) => left.order - right.order);
                    const groupRefs =
                        spec.groupKeys === undefined
                            ? owned.map((group) => group.id)
                            : owned.filter((group) => spec.groupKeys?.includes(group.key)).map((group) => group.id);

                    report.push({
                        name: 'raiseFinding',
                        args: {
                            target_ref: item.unit?.ref ?? item.storyId,
                            criterion_ref: spec.criterion ?? 'C-4',
                            title: spec.title ?? `Deep review: the Overview claimed on ${item.id} leaves the Seed's promise unpaid`,
                            detail: `The Overview as installed states an obligation the rest of the Summary never pays; the section is where it stops (reviewed on ${item.id}).`,
                            evidence: `the deep-review pass read the installed Overview at ${item.id} against the Seed and found the promise unpaid`,
                            cost: spec.cost,
                            // D-33c reads the ROW's kind, so a fixture that wants a proposal says so here.
                            ...(spec.kind === undefined ? {} : { kind: spec.kind }),
                            // R3: the group scope, and the ONLY scope a grouped Summary finding may carry.
                            group_refs: groupRefs.length > 0 ? groupRefs : item.groupRefs ?? [],
                            why: 'The Critic angle: what a reader of this Author would object to (D-30, R3).'
                        }
                    });
                }
            }

            return report;
        }

        case 'select': {
            const unit = item.unit;

            if (unit === undefined) return [];

            const drafts = store.revisions
                .list()
                .filter(
                    (revision) =>
                        revision.unit_ref === unit.ref &&
                        (revision.state === 'drafted' || revision.state === 'competing')
                )
                .sort((left, right) => left.id.localeCompare(right.id));
            const winner = drafts[0];

            if (winner === undefined) return [];

            // L-17/T-2a: the note names the rule and what was preferred — the tool writes it verbatim.
            return [
                {
                    name: 'selectRevision',
                    args: {
                        unit_ref: unit.ref,
                        revision_id: winner.id,
                        selection_note: `rule: keeps the chapter contract; ${winner.id} states the change on the page`
                    }
                }
            ];
        }

        case 'verify_findings': {
            const refs = item.findingRefs ?? [];

            // T6/R2d: the silent answer is the no-decision thread — the run closes, the finding stays
            // `unconfirmed`, and the loop has to bound what it buys next rather than re-asking forever.
            if (crew.verifyReports === 'silent') return [];

            return refs.map((findingId) => {
                const finding = store.findings.get(findingId);
                const verdict =
                    crew.verdictFor !== undefined && finding !== undefined
                        ? crew.verdictFor(finding)
                        : { verdict: 'confirmed' as const };

                // D-33/D-34a: one claim the Author can read in one pass, and the cost it DESERVES.
                const calls: ScriptCall[] = [
                    {
                        name: 'verifyFinding',
                        args: {
                            finding_id: findingId,
                            verdict: verdict.verdict,
                            ...(verdict.cost === undefined || finding === undefined ? {} : { cost: verdict.cost }),
                            title: finding?.title ?? 'a claim to check',
                            evidence: `checked against the artifact: ${finding?.evidence ?? ''}`
                        }
                    }
                ];

                // Phase ①'s granular pipeline approves in the same thread, so the Critic's own
                // confirmation has an approved finding to check. A dispute needs no approval, and
                // phase ①'s bar is critical/major — a minor/taste note is recorded, never work.
                const story = store.stories.get(item.storyId);
                const blocking = finding !== undefined && (finding.cost === 'critical' || finding.cost === 'major');
                const covered = finding !== undefined && (story?.auto_approve ?? []).includes(finding.cost);

                if (
                    finding !== undefined &&
                    verdict.verdict === 'confirmed' &&
                    covered &&
                    (story?.phase !== 'summary' || blocking)
                ) {
                    calls.push({
                        name: 'approveFinding',
                        args: {
                            finding_id: findingId,
                            decision: 'auto',
                            why: 'the Editor confirmed the claim and the Story dial covers it; the Critic performs the independent second look'
                        }
                    });
                }

                return calls;
            }).flat();
        }

        case 'confirm_finding': {
            const refs = item.findingRefs ?? [];

            return refs.map((findingId) => {
                const finding = store.findings.get(findingId);
                const verdict = crew.criticConfirm ?? 'confirm';

                return {
                    name: 'confirmFinding',
                    args: {
                        finding_id: findingId,
                        verdict,
                        evidence: `independent re-read of the cited passage on ${finding?.target_ref ?? 'the unit'}: ${finding?.evidence ?? ''}`,
                        why:
                            verdict === 'confirm'
                                ? 'the Critic checked the passage itself and the defect holds'
                                : 'the Critic checked the passage itself and does not believe the defect'
                    }
                };
            });
        }

        case 'verify_ideas':
            return (item.ideaRefs ?? []).map((ideaId) => ({
                name: 'verifyIdea',
                args: {
                    idea_id: ideaId,
                    verdict: crew.ideaVerdict ?? 'verified',
                    evidence: 're-read the cited source; it says what the Idea claims',
                    meets_guidelines: true
                }
            }));

        // The Author's channel is the Editor: its review turns the directive into queue entries.
        // The rig's directive names the artifact refs the server resolved, so one task per target is
        // exactly the plan a model would write from the same brief (D-19).
        case 'directive_work': {
            const directive = item.directiveRef ? store.directives.get(item.directiveRef) : undefined;
            const targets = directive?.targets ?? [];

            return targets
                .filter((ref) => ref !== item.storyId)
                .map((ref) => ({
                    name: 'createTask',
                    args: {
                        title: `propagate: ${directive?.text.slice(0, 120) ?? 'the directive'}`,
                        detail: `${item.directiveRef} · ${ref}`,
                        owner_role: 'writer',
                        priority: 1,
                        why: `the Editor queued the Author's directive onto ${ref} (D-19, D-11)`
                    }
                }));
        }

        default:
            return [];
    }
}

/**
 * The JSON answer of a `toolMode: 'none'` run (§6.4 steps 3-4). The request carries the schema in
 * `responseFormat`, so the rig knows which job it is answering without reading the live run rows —
 * and for a sample, `seed` is the 1-based sample index the Work Item set (§5's only diversity knob),
 * which is what keeps two live samplers distinguishable under a wider capacity.
 *
 * An answer the caller scripts as a STRING is returned verbatim: `"not json"` is how the schema
 * failure path is driven (two attempts, no revision, the attempt counter re-arms the round).
 */
function structuredAnswer(
    store: Store,
    items: Map<string, WorkItem>,
    request: ChatRequest,
    crew: CrewBehaviour
): string {
    const prompt = request.messages.map((message) => message.content).join('\n\n');
    // The answer contract names the job (T-11): `IssueList` is the screening pass, `GroupDraft` and
    // `GroupReview` are the Summary Phrase's per-group Writer and Reviewer, `SectionScores` is D-65's
    // Reader scoring pass, `GroupLockDecision` is R3/T6b's Editor judgement seat, and anything else in a
    // schema-constrained request is the legacy whole-Summary sampler. Each literal is the matching
    // `*_SCHEMA_NAME` constant from `shared/schemas`.
    const formatName = request.responseFormat?.name;
    const kind: WorkItem['kind'] =
        formatName === 'IssueList'
            ? 'screen_samples'
            : formatName === 'GroupDraft'
              ? 'draft_groups'
              : // PHRASE ② (T-W2): the chapter lane's draft job — the SAME Work Item kind as the Summary's
                // batch (`draft_groups`), distinguished only by the contract it answers under. The literal
                // is `CHAPTER_DRAFT_SCHEMA_NAME` from `shared/schemas/chapter-draft.ts`.
                formatName === 'ChapterDraft'
                ? 'draft_groups'
                : formatName === 'GroupReview'
                  ? 'review_groups'
                  : formatName === 'SectionScores'
                    ? 'score_sections'
                    : formatName === 'GroupLockDecision'
                      ? 'group_lock'
                      : 'sample_unit';
    const pool = store.runs
        .list()
        .filter((run) => LIVE_RUN_STATES.includes(run.state))
        .map((run) => items.get(run.work_item_ref ?? ''))
        .filter((item): item is WorkItem => item !== undefined && item.kind === kind);

    const chosen =
        pool.find((item) => item.sampleIndex !== undefined && item.sampleIndex === request.seed) ??
        groupJobOf(pool, prompt) ??
        (pool.length === 1 ? pool[0] : pool[pool.length - 1]);

    // No live job of that kind: `{}` fails the schema on purpose, so the run's failure is visible in
    // the same way a real mis-dispatch would be rather than being papered over with a clean answer.
    if (chosen === undefined) return '{}';

    if (kind === 'sample_unit') {
        const logline = /logline: (.*)/.exec(prompt)?.[1]?.trim() ?? 'the Seed Brief';
        const sampleIndex = chosen.sampleIndex ?? 1;
        const answer =
            crew.sampleAnswer !== undefined
                ? crew.sampleAnswer({ item: chosen, sampleIndex, prompt })
                : defaultSampleAnswer(sampleIndex, logline);

        return typeof answer === 'string' ? answer : JSON.stringify(answer);
    }

    // R2 — the Summary Phrase's per-group Writer. The group ids come from the WORK ITEM, not from the
    // prompt: the job is the authority on what it asked for, and answering exactly that set is what
    // `parseGroupDraftAnswer` accepts.
    if (kind === 'draft_groups') {
        const groupRefs = chosen.groupRefs ?? [];
        // PHRASE ② (T-W2): the CONTRACT decides the answer shape, and the contract is the request's own
        // `response_format.name`. A chapter batch answers plotpoints; a Summary batch answers prose.
        // Both are `draft_groups`, and the engine validates them through different parsers
        // (`phrase/plotpoints.ts:parseChapterDraftAnswer` vs `phrase/revisions.ts:parseGroupDraftAnswer`),
        // so answering a chapter job with a `GroupDraft` would refuse the whole install.
        const chapter = formatName === 'ChapterDraft';
        const answer = chapter
            ? crew.chapterDraft !== undefined
              ? crew.chapterDraft({ item: chosen, groupRefs, prompt })
              : defaultChapterDraftAnswer(groupRefs)
            : crew.groupDraft !== undefined
              ? crew.groupDraft({ item: chosen, groupRefs, prompt })
              : defaultGroupDraftAnswer(groupRefs);

        return typeof answer === 'string' ? answer : JSON.stringify(answer);
    }

    // R5 — the Reviewer reads the group revision that is ALREADY current (an accepted result installs
    // first), and every complaint names its groups so R3's closure rule has something to gate on.
    if (kind === 'review_groups') {
        const groupRefs = chosen.groupRefs ?? [];
        const answer =
            crew.groupReview !== undefined ? crew.groupReview({ item: chosen, groupRefs, prompt }) : { issues: [] };

        return typeof answer === 'string' ? answer : JSON.stringify(answer);
    }

    // D-65 — the Reader's scoring pass. Same authority rule as the two group branches: the WORK ITEM
    // carries the five groups the seat was claimed against, and answering exactly that set is what
    // `parseSectionScoreAnswer` accepts (an answer naming a group the job never carried is refused).
    if (kind === 'score_sections') {
        const groupRefs = chosen.groupRefs ?? [];
        const answer =
            crew.sectionScores !== undefined
                ? crew.sectionScores({ item: chosen, groupRefs, prompt })
                : defaultSectionScoreAnswer(groupRefs);

        return typeof answer === 'string' ? answer : JSON.stringify(answer);
    }

    // R3/T6b — the Editor's judgement seat. One group, straight off the WORK ITEM: the seat's key names
    // exactly one section, `run/executor.ts` refuses a `group_lock` job that carries more, and
    // `parseGroupLockAnswer` refuses an answer that decides a DIFFERENT section than the seat was claimed
    // for. So the default has one possible subject, and a test that wants "the other section" scripts it.
    //
    // The pool above resolves it by prompt because N lock seats (one per section) can be live at once:
    // `groupJobOf` matches the group ids the compiler put in front of the model, which is what keeps a
    // five-seat sweep from answering every seat with the same section.
    if (kind === 'group_lock') {
        const groupRefs = chosen.groupRefs ?? [];
        const answer =
            crew.groupLock !== undefined
                ? crew.groupLock({ item: chosen, groupRefs, prompt })
                : defaultGroupLockAnswer(groupRefs);

        return typeof answer === 'string' ? answer : JSON.stringify(answer);
    }

    const revisionId = chosen.revisionRef ?? '';
    const answer =
        crew.screenAnswer !== undefined
            ? crew.screenAnswer({ item: chosen, revisionId, prompt })
            : { issues: [] as IssueList['issues'] };

    // H1/R2 — a screening job that carried fix tasks owes a certificate for every one of them, or the
    // round it belongs to has no certifiable candidate and never selects (the hill-climb, R3). The
    // ids come from the WORK ITEM, which is the list the prompt rendered, so the mock cannot certify
    // a fix the Critic was never handed. `src/server/integration/harness.ts` carries the same default
    // for the full-server tests; the two mocks stay separate so neither imports the other's world.
    const fixIds = chosen.fixRefs ?? [];
    const certified =
        typeof answer === 'string' || answer.fix_verifications !== undefined || fixIds.length === 0
            ? answer
            : {
                  ...answer,
                  fix_verifications:
                      crew.screenFixes?.({ item: chosen, revisionId, prompt, fixIds }) ??
                      fixIds.map((fix_ref) => ({
                          fix_ref,
                          status: 'resolved' as const,
                          evidence: targetDraftLineOf(prompt) ?? `${fix_ref} is answered by the target draft`
                      }))
              };

    return typeof certified === 'string' ? certified : JSON.stringify(certified);
}

/**
 * The group job this prompt belongs to (R2). A group Work Item's target ref is the STORY, so when a
 * batch has more than one group in flight the prompt's GROUPS block is the only thing that names
 * which group THIS turn was dispatched for — `### <Title> (group_ref=<id>, …)`
 * (`run/phase1-prompt.ts:renderGroupEntry`). Matching it keeps two live group runs from answering
 * each other; a prompt that names more than one live job (or none) falls through to the caller's
 * ordinary tie-break.
 */
function groupJobOf(pool: WorkItem[], prompt: string): WorkItem | undefined {
    const named = /group_ref=([A-Za-z0-9_-]+)/.exec(prompt)?.[1];

    if (named === undefined) return undefined;

    const matches = pool.filter((item) => (item.groupRefs ?? []).includes(named));

    return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The default group Writer answer: one entry per requested group, with content that names the group
 * id so a test can trace which Group Revision an install created and prove an untouched group kept
 * its exact bytes. `knowledge_used` is empty because the rig seeds no knowledge rows by default.
 */
const defaultGroupDraftAnswer = (groupRefs: string[]): GroupDraft => ({
    groups: groupRefs.map((group_ref) => ({
        group_ref,
        content: `The ${group_ref} line this story refuses to lose.`
    })),
    knowledge_used: []
});

/**
 * The default `ChapterDraft` answer (PHRASE ②, T-W2): one entry per group ref the Work Item carried, in
 * that order, with both required plotpoints filled in.
 *
 * WHY THE EXACT-SET RULE: `phrase/plotpoints.ts:parseChapterDraftAnswer` refuses the whole batch for one
 * missing chapter, one extra chapter, or a blank `must_happen`/`must_change` — a chapter title with no
 * contract is not a contract — so a default that left either field empty would make every loop test about
 * the chapter lane a test about a refused install.
 *
 * The plotpoints are worded off the ENTRY, not off a counter, because the entry key (`chapter_3`) is the
 * identity the `plotlines` mirror writes at that order: a test that wants to know which chapter produced a
 * contract row can read the number out of the installed text. A test that wants particular prose — or a
 * deliberately thin answer — scripts `crew.chapterDraft`.
 */
const defaultChapterDraftAnswer = (groupRefs: string[]): ChapterDraft => ({
    groups: groupRefs.map((group_ref) => ({
        group_ref,
        heading: `The turn at ${group_ref}`,
        must_happen: `What ${group_ref} has to put on the page: the event the chapter exists to deliver.`,
        must_change: `What is different when ${group_ref} ends — the position, the knowledge, or the debt.`,
        pov: 'the keeper',
        setups: `The thing ${group_ref} plants that a later chapter collects.`,
        payoffs: `The thing ${group_ref} collects that an earlier chapter planted.`
    })),
    knowledge_used: []
});

/**
 * The default `SectionScores` answer (D-65): one entry per group the seat carried, in the SAME order, at
 * `60 + 8 × position` — premise 60, promise 68, theme 76, tone 84, ending 92. The spread (rather than one
 * constant) is what makes a five-section rail legible in a fixture and keeps every value inside the
 * schema's 1-100 range; a test that wants a specific number scripts `crew.sectionScores`.
 *
 * Both text fields are non-empty on purpose: `parseSectionScoreAnswer` refuses a score with no rationale
 * or no quoted line (D-15), so a default that left either blank would write no rows and every loop test
 * about the scoring seat would silently be a test about nothing. The evidence line quotes the content the
 * default group Writer answer installs, which is the passage the seat was shown.
 */
const SECTION_SCORE_BASE = 60;
const SECTION_SCORE_STEP = 8;

const defaultSectionScoreAnswer = (groupRefs: string[]): SectionScores => ({
    sections: groupRefs.map((group_ref, index) => ({
        group_ref,
        score: SECTION_SCORE_BASE + index * SECTION_SCORE_STEP,
        rationale: `${group_ref} holds together as written and is contradicted by none of the other sections`,
        evidence: `The ${group_ref} line this story refuses to lose.`
    }))
});

/**
 * The default `GroupLockDecision` answer (R3/T6b): LOCK the ONE section the seat carried, with a rationale
 * that names it. The default says yes because a lock seat is only ever armed when the book already allows
 * the freeze — the Setting is on, the section's current text IS the clean selection, a Reader row exists at
 * that exact vector, and no Writer holds it — so what a default-driven test wants to see is the FLAG. Every
 * other outcome is scripted: `crew.groupLock` answers `false` or hands back a malformed decision, and a
 * state that moved under the pass is driven by moving the rows between the claim and the settle.
 *
 * The rationale is non-blank for the same reason the score default's is: `parseGroupLockAnswer` refuses a
 * decision with no reason (D-15), and a default that left it blank would turn every lock test into a test
 * about a refusal.
 */
const defaultGroupLockAnswer = (groupRefs: string[]): GroupLockDecision => ({
    group_ref: groupRefs[0] ?? '',
    lock: true,
    rationale: `${groupRefs[0] ?? ''} is contradicted by none of the locked peers and no open claim names it — nothing here is left for the loop to rewrite`
});

/**
 * The first line of the screen prompt's `## TARGET DRAFT` section — the quotation the default
 * certificate answers with. `undefined` when the prompt carries no draft, and the caller then says so
 * in words rather than inventing a quote (D-15: an evidence line has to come from the text).
 */
function targetDraftLineOf(prompt: string): string | undefined {
    const draft = prompt.split('## TARGET DRAFT\n')[1] ?? '';
    const line = /^[a-z_]+: .*/m.exec(draft)?.[0];

    return line === undefined ? undefined : line.trim();
}


/** The default sampler answer: the six §4.2 prose blocks, each provably derived from the round. */
const defaultSampleAnswer = (sampleIndex: number, logline: string): SummarySample => ({
    premise: `sample ${sampleIndex}: ${logline}`,
    promise: `sample ${sampleIndex} pays the promise the Seed makes`,
    theme: `sample ${sampleIndex} theme`,
    tone: `sample ${sampleIndex} tone`,
    ending: `sample ${sampleIndex} ending`,
    world_rules: `sample ${sampleIndex} world rules`,
    knowledge_used: []
});

/** The refs a reader's verdicts have to cover for the phase Goal to be answerable (criteria engine). */
function verdictTargets(store: Store, item: WorkItem): Array<{ ref: string; kind: string }> {
    const unit = item.unit;
    // C-4 (cross-plotline consistency) and the whole-Story level are scoped to the STORY row
    // (criteria/engine.ts:scopeTargets), so a per-unit reader pass also files its Story-level judgement.
    // A cross-cutting reader judging one unit is exactly the run that can answer "do these agree?".
    const story = { ref: item.storyId, kind: 'story' };

    // The whole-Story pass judges the STORY, not each chapter: the chapters already have their own check
    // jobs, and a whole-Story run that re-files chapter verdicts would keep invalidating its own work
    // (work.ts:wholeStoryCandidate skips the pass when its verdict is newer than every chapter verdict).
    if (item.kind === 'whole_story_check') return [story];

    // A drain-probe round over a finished book is the same judgement, so it judges the STORY too. It
    // must not re-file chapter verdicts: those would post-date the whole-Story pass and re-arm it, and
    // the probe round would drag a second whole-Story run along with it (L-15a wants ONE pass).
    if ((item.note ?? '').includes('probe round')) return [story];

    if (unit !== undefined && unit.ref !== '') return [{ ref: unit.ref, kind: unit.kind }, story];

    const chapters = store.chapters.list().filter((chapter) => chapter.story_id === item.storyId);

    if (chapters.length > 0)
        return [
            ...chapters.map((chapter) => ({ ref: chapter.id, kind: 'chapter' })),
            { ref: item.storyId, kind: 'story' }
        ];

    const plotlines = store.plotlines.list().filter((plotline) => plotline.story_id === item.storyId);

    if (plotlines.length > 0)
        return [
            ...plotlines.map((plotline) => ({ ref: plotline.id, kind: 'plotline' })),
            { ref: item.storyId, kind: 'story' }
        ];

    const summary = store.summaries.list().find((row) => row.story_id === item.storyId);

    return summary === undefined ? [{ ref: item.storyId, kind: 'story' }] : [{ ref: summary.id, kind: 'summary' }];
}

// ---------------------------------------------------------------------------
// The two tool overrides this package needs
// ---------------------------------------------------------------------------

/**
 * W2's double writes a chapter in place. The loop's rules do not: P13 says competing drafts are the
 * whole mechanism, D-21 says a draft is invisible until an Editor picks one, and D-22 says the choice is
 * what lands the prose. So `editChapter` creates a §4.15 revision and `selectRevision` applies the
 * winner's body — everything else keeps W2's behaviour.
 */
function crewTools(crew: CrewBehaviour): Record<string, MockToolHandler> {
    void crew;

    return {
        // F2 — PHRASE ②'s structuring write, on the loop rig's tool runtime. The run layer's default
        // double (`run/mock.ts:defaultTools`) implements `structureSeed` and never learned this one, so the
        // rig supplies it here: without a handler the executor answers T-6c ("no tool named
        // `structurePlotlines`"), which is how the lane's structuring seat could only ever call the
        // phase-① write and pretend it had worked.
        //
        // It is the SAME pair of domain calls the real tool makes in one commit
        // (`tools/plotlines.ts:structurePlotlines` → `createPlotlineBrief` + `acceptPlotlineBrief`), so the
        // accept still writes `summaries.chapter_count` and materializes `chapter_1..chapter_N` (D-3b)
        // exactly as the product does. The `seed_hash` guard is the product's P5 guard: a seat that answers
        // with a hash the record does not hold is refused, not silently accepted.
        structurePlotlines: (ctx, args, runtime) => {
            const story = runtime.store.stories.get(ctx.storyId);
            const phrase =
                story === undefined ? undefined : storyPhraseByKey(runtime.store, ctx.storyId, PHRASE_PLOTLINES_KEY);

            if (story === undefined || phrase === undefined)
                return {
                    ok: false,
                    refused: 'T-11',
                    message: `story ${ctx.storyId} has no Plotlines Phrase — the Author starts Phrase ②, the loop never invents its seed (P5, one phrase down)`
                };

            // P5: the hash the seat was shown is the hash of THIS phrase's copied seed, never the Story's
            // Seed — `phraseSeedOf` is the domain's own read, so the check cannot drift from the hash every
            // Phrase-② gate uses.
            const seedHash = seedHashOf(phraseSeedOf(phrase, story));

            if (args.seed_hash !== seedHash)
                return {
                    ok: false,
                    refused: 'P5',
                    message: `structurePlotlines refuses seed_hash ${String(args.seed_hash)} — this phrase's seed hashes ${seedHash} (P5)`
                };

            const chapterCount = Math.trunc(Number(args.chapter_count));

            if (!Number.isInteger(chapterCount) || chapterCount < 1)
                return {
                    ok: false,
                    refused: 'T-11',
                    message: `chapter_count ${String(args.chapter_count)} is not a positive whole number (D-3b)`
                };

            // IDEMPOTENT like the real tool: a seat re-armed on the same hash reports the brief it already
            // accepted instead of minting a second one (the accept is what makes the entry set, so a second
            // accept would re-run `ensureChapterGroups` on a set that already exists).
            const accepted = runtime.store.plotlineBriefs
                .list()
                .find((brief) => brief.phrase_id === phrase.id && brief.seed_hash === seedHash);

            if (accepted !== undefined) return { ok: true, rev: accepted.rev };

            const attribution = { run_ref: ctx.runRef, why: `the Editor structured Phrase ② (D-3b)` };
            const brief = createPlotlineBrief(
                runtime.store,
                story,
                phrase,
                { chapter_count: chapterCount },
                attribution
            );
            const result = acceptPlotlineBrief(runtime.store, story, brief, attribution);

            return { ok: true, rev: result.brief.rev };
        },

        editChapter: (ctx, args, runtime) => {
            const chapterId = typeof args.chapter_id === 'string' ? args.chapter_id : '';
            const chapter = runtime.store.chapters.get(chapterId);

            if (chapter === undefined || chapter.story_id !== ctx.storyId) {
                return {
                    ok: false,
                    refused: 'T-3',
                    message: `chapter ${chapterId} is not in story ${ctx.storyId} (T-3)`
                };
            }

            // §4.15's row: the body is the draft, `run_ref` is who wrote it, `competing` is the state an
            // Editor's choice resolves (P13).
            runtime.store.revisions.create(
                {
                    story_id: ctx.storyId,
                    unit_kind: 'chapter',
                    unit_ref: chapter.id,
                    body: JSON.stringify({ title: chapter.title, sections: args.sections ?? [] }),
                    run_ref: ctx.runRef,
                    state: 'competing',
                    verdict_refs: []
                },
                { run_ref: ctx.runRef, why: `a Writer drafted a competing version of ${chapter.id} (P13, D-21)` }
            );

            return { ok: true, rev: chapter.rev };
        },

        selectRevision: async (ctx, args, runtime) => {
            const unitRef = typeof args.unit_ref === 'string' ? args.unit_ref : '';
            const revisionId = typeof args.revision_id === 'string' ? args.revision_id : '';
            const winner = runtime.store.revisions.get(revisionId);

            if (winner === undefined)
                return {
                    ok: false,
                    refused: 'T-4',
                    message: `revision ${revisionId} is gone (T-4: re-read before applying)`
                };

            // §4.15's `body` is `unknown` on purpose (a draft is prose, JSON, or a patch — the loop never
            // interprets it). This rig stores JSON, so it reads it back defensively: a string is parsed,
            // anything already structured is used as-is.
            const body = (typeof winner.body === 'string' ? JSON.parse(winner.body) : winner.body) as {
                title?: string;
                sections?: Array<{ id: string; text: string; origin: 'author' | 'writer' }>;
            };

            for (const loser of runtime.store.revisions
                .list()
                .filter((revision) => revision.unit_ref === unitRef && revision.id !== revisionId)) {
                runtime.store.revisions.delete(loser.id, {
                    run_ref: ctx.runRef,
                    why: `an Editor chose ${revisionId}; the loser is gone (P13, L-17)`
                });
            }

            // The prose only becomes the artifact when the choice is made (D-22). The default double leaves
            // the body unapplied, which would make every chapter a permanent shell.
            const chapter = runtime.store.chapters.get(unitRef);

            if (chapter !== undefined) {
                runtime.store.chapters.update(
                    chapter.id,
                    { sections: body.sections ?? chapter.sections, current_revision: revisionId },
                    { run_ref: ctx.runRef, why: `the Editor's choice landed as the chapter's prose (D-22, P13)` },
                    [{ id: chapter.id, rev: chapter.rev }]
                );
            }

            runtime.store.revisions.update(
                revisionId,
                {
                    state: 'selected',
                    selection_note: typeof args.selection_note === 'string' ? args.selection_note : ''
                },
                { run_ref: ctx.runRef, why: `an Editor selected ${revisionId} (L-17, T-2a)` },
                [{ id: revisionId, rev: winner.rev }]
            );

            return { ok: true, rev: winner.rev };
        }
    };
}

// Re-exported so a test file does not have to reach into the run layer for its own fixtures.
export {
    seedChapter,
    seedDigest,
    seedFinding,
    seedGoal,
    seedIdea,
    seedPlotline,
    seedRevision,
    seedTask,
    seedTemplate,
    MockToolRuntime
};
