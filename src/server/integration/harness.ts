// §15's vertical slice, driven through the REAL server (W10).
//
// What this module is: the scripted CREW. Every suite here boots the shipped server
// (`startStorylineServer`, `port: 0`) with the shipped Store, run executor, §8 tool catalogue,
// criteria engine and Digest builder, and injects exactly one double — a `MockChatClient` whose
// answers are the crews' tool calls, and, for phase ①'s `toolMode: 'none'` runs, the validated
// JSON the request's `responseFormat` asks for (`structuredAnswer`). That is what makes these
// integration tests rather than route tests: a loop decision is only proven when a real run,
// holding a real lease and a real brief, calls a real tool that really refuses or really writes.
//
// Why the crew is scripted from the BRIEF and not from a call index: a run's whole memory is the
// brief (S-2, P2), so the honest double reads it the way a model does — which unit it is judging
// (`run/brief.ts:artifactHeading`), which drafts are competing (`revision_id=` lines), which
// findings and Ideas are in front of it (`- finding_1 [...]` lines) — and answers THAT. A
// call-index script passes silently when the loop changes the ORDER of runs while changing their
// meaning, which is exactly the class of bug §15 exists to catch.
//
// Two rules the scripted crew obeys because a real one must:
//   - it re-acts to a refusal it was handed. `run/brief.ts:renderEtiquette` tells a model verbatim:
//     "a rejected write comes back with the CURRENT record: re-apply your change against that, and
//     send it again with the rev you were handed". The crew does exactly that, once per run —
//     the loop has no turn cap (E-0), so an uncapped re-send of a losing CAS race would spin.
//   - it never invents a rule the catalogue does not have: one verdict line per criterion the brief
//     actually briefed it on, split across the two scopes the criteria engine aggregates over
//     (`criteria/engine.ts:scopeTargets`) — the artifact for everything except C-4/C-10/C-11/C-13,
//     which are filed at the Story row.
//   - it answers a `toolMode: 'none'` run in the contract the run advertises: the default
//     `SummarySample` proves its provenance by echoing the prompt's logline, and the default
//     `IssueList` is the clean round `{"issues":[]}`. `sampleAnswer`/`screenAnswer` are the knobs
//     that make one sample lose the comparison or fail validation on purpose.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startStorylineServer, type StorylineRuntimeOptions, type StorylineServerHandle } from '../api/server';
// THE PROJECTION A RESTARTED PANEL IS READ FROM. `api/projections.ts:storyRow` is the one function
// `GET /stories` renders a Stories row with, and it is pure over `(store, criteria, digest)` — so the
// restart step of §15's L-26 can render the row a SECOND Store over the same book answers, which is what
// a restarted server paints, instead of reading the live server a second time.
import { storyRow as projectStoryRow } from '../api/projections';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
// S-RUNTIME: the fixture exposes one Story's runtime and the app-config book, so a slice test can assert on
// a Story's own files instead of on one shared book (`context`, `storyDir`, `appConfig`).
import type { ServerConfig } from '../runtime/server-config';
import type { StoryRuntimeContext, StoryRuntimes } from '../runtime/story-runtimes';
import { MockChatClient, type MockHandler, calls, msg } from '../llm/mock';
import type { ChatRequest, ChatResponse, ToolCall } from '../llm/client';
import { Store } from '../store/store';
import { seedHashOf } from '../../shared/seed-hash';
import {
    ISSUE_LIST_SCHEMA_NAME,
    SUMMARY_SAMPLE_SCHEMA_NAME,
    GROUP_DRAFT_SCHEMA_NAME,
    GROUP_REVIEW_SCHEMA_NAME,
    SECTION_SCORES_SCHEMA_NAME,
    // PHRASE ② (T-W2): the chapter contract's answer contract. It is a DIFFERENT schema from
    // `GroupDraft` on purpose — a Summary group's answer is prose, a chapter entry's answer is
    // plotpoints — so the mock needs its own branch rather than a flag on the draft one.
    CHAPTER_DRAFT_SCHEMA_NAME
} from '../../shared/schemas';
import type {
    ChapterDraft,
    GroupDraft,
    GroupReview,
    IssueList,
    SectionScores,
    SummarySample
} from '../../shared/schemas';
import { PHRASE_PLOTLINES_KEY } from '../../shared/phrase';
import type { Chapter, Cost, Idea, Plotline, Revision, SampledFixVerification, Story, Summary, Verdict } from '../../shared/types';

// ---------------------------------------------------------------------------
// The provider triple, so a test process never reaches the network
// ---------------------------------------------------------------------------

/**
 * A complete triple pointing at a port nothing listens on. `buildStorylineRuntime` resolves the
 * triple from `env` even when a `chat` client is injected (R11), and an ambient
 * `STORYLINE_PROVIDER_MODEL` in a developer's shell must not leak into a run row.
 */
export const TEST_PROVIDER_ENV = {
    STORYLINE_PROVIDER_BASE_URL: 'http://127.0.0.1:1/providers/private/v1',
    STORYLINE_PROVIDER_MODEL: 'scripted/basalt',
    STORYLINE_PROVIDER_API_KEY: 'test-key',
    STORYLINE_PORT: '0'
} as const;

// ---------------------------------------------------------------------------
// The scripted crew's contract
// ---------------------------------------------------------------------------

/** One tool call the scripted crew asks for; `args` is the OpenAI wire payload. */
export type CrewCall = { name: string; args?: Record<string, unknown> };

/** A refusal the tool layer gave a crew, in call order, with the rule id and the field it named. */
export type CrewRefusal = {
    template: string;
    tool?: string;
    rule?: string;
    message?: string;
    field?: string;
    expected?: string;
    received?: string;
};

/** Everything the crew can see when it answers: the brief, the store, and this session's outcome so far. */
export interface CrewContext {
    request: ChatRequest;
    template: string;
    kind: string;
    turn: number;
    store: Store;
    story?: Story;
    summaryId?: string;
    /** The tool results of this session's earlier turns — what a model reads next. */
    results: Array<Record<string, unknown>>;
    /** The refusals among those results, in call order. */
    refusals: Array<Record<string, unknown>>;
    /** The criteria the brief actually briefed this crew on, in brief order. */
    criteria: string[];
    /** The phase the brief's PHASE section names — where a Critic's Idea belongs. */
    phase: string;
    unitTarget?: string;
    /** The competing draft a review job names (`revision_id=` in the brief), if any. */
    draftIds: string[];
    /**
     * True for a tool-carrying DEEP REVIEW, whichever family dispatched it — the job note now says
     * `Critic pass N/M on the selected Summary draft …` (sampling), `… on the installed group
     * Overview …` (group), or `… on the installed chapter contracts …` (Phrase ②, T-W2). See
     * `readBrief`'s `reviewPass` for the note sources.
     */
    reviewPass: boolean;
    /**
     * True only for Phrase ②'s chapter-contract pass (T-W2): the seat that judges the chapter SET the
     * install wrote and files at the Story row. `criticFinds` uses it to fire on the chapter lane only,
     * so a fixture that wants a phase-② defect does not also hold phase ①'s review open.
     */
    chapterPass: boolean;
    /** The Story's Summary row id, which is where `chapter_count` lives (D-3b: Author truth). */
    summary?: Summary;
    /** D-19: the directive this review thread must turn into tasks. */
    directiveRef?: string;
    /** The artifacts the server already resolved from the directive's sentence. */
    directiveTargets: string[];
    options: CrewOptions;
}

/** A crew's whole answer. Default `content` is a report line, because S-4 ends a session on one. */
export type CrewScript = (ctx: CrewContext) => { toolCalls?: CrewCall[]; content?: string };

export interface CrewOptions {
    /** Replace a template's script outright, keyed by `template_ref`. */
    scripts?: Record<string, CrewScript>;
    /** Criteria reported as FAILING, so a phase Goal cannot pass yet (§15 step 2). */
    failCriteria?: string[];
    /** Criteria left out of `criteria_passed[]` entirely — "not checked at all". */
    omitCriteria?: string[];
    /** Cost of a finding the Reader files on each chapter unit it judges (§15 step 3a). */
    raiseFindings?: Cost;
    /** How many Ideas each Critic run files; the shipped default of 1 matches §6.7's probe round. */
    criticIdeas?: number;
    /**
     * A deep-review Critic pass files one defect at this cost (§6.4 step 6). The function form
     * decides per pass, so a test can make the flaw a one-round event (the selected draft's id is
     * in `ctx.draftIds`).
     */
    criticFinds?: Cost | ((ctx: CrewContext) => Cost | undefined);
    /** Verify Ideas as `refuted` instead of `confirmed`, so the tray gets a real rejection (D-27). */
    refuteIdeas?: boolean;
    /** Extra tool calls a Reader run makes on a chapter unit before reporting (U-3's drill). */
    readerDrill?: boolean;
    /** The assistant run's final answer line (A-1: plain text to the Author, no writes). */
    assistantNote?: string;
    /**
     * The JSON a `sample_unit` run answers (§6.4 step 3). The default derives the six prose fields
     * from the compiled prompt's Seed Brief and echoes the prompt's Knowledge fingerprints, so the
     * installed Summary provably came from the round's prompt. Return a STRING to answer raw text
     * instead — `'not json'` is how the schema-repair and retry-cap rows are driven
     * (`src/server/run/executor.ts:STRUCTURED_ATTEMPTS`).
     */
    sampleAnswer?: (turn: SampleTurn) => SummarySample | string;
    /**
     * The JSON a `screen_samples` run answers (§6.4 step 4). Default `{issues: []}` — a clean
     * draft. A test maps `sampleIndex` to a canned critical/high issue to make the deterministic
     * selector pick a known winner (`src/server/loop/sample-select.ts`).
     */
    screenAnswer?: (turn: ScreenTurn) => IssueList | string;
    /**
     * H1/R2 — the certificate this screening pass returns for the fix tasks its prompt named. The
     * default marks every demanded task `resolved` with the target draft's own premise line as the
     * evidence, because the mock crew is a cooperative model: what a test wants to exercise is the
     * ENGINE's reaction to a certificate, not the model's ability to write one. Return `[]` to
     * simulate a pass that ignored the fix section, or a `status: 'unresolved'` entry to reject a
     * candidate (`src/server/loop/sample-select.ts:scoreSample`).
     */
    screenFixes?: (turn: ScreenTurn) => SampledFixVerification[];
    /**
     * SUMMARY PHRASE R2/R5 — the JSON a `draft_groups` run answers. The default answers for EVERY group
     * the prompt named, copying `group_ref` out of that group's heading and writing content derived from
     * its KEY and the Seed's logline, so an installed group provably came from the prompt that asked for
     * it — the same guarantee `defaultSampleAnswer` gives the sampler. Return a STRING to answer raw text
     * (the schema-repair rows), or an answer naming a group outside the batch: that is a refusal the
     * whole batch pays for (`phrase/revisions.ts:parseGroupDraftAnswer`), which is how a slice drives
     * R2's all-or-none install.
     */
    groupDraft?: (turn: GroupDraftTurn) => GroupDraft | string;
    /**
     * SUMMARY PHRASE R3 — the JSON a `review_groups` run answers. Default `{issues: []}`, a clean
     * Overview. A slice scripts an issue whose `group_refs` are ids from `turn.groups` — the attribution
     * the loop routes the Writer batch by, and the anchor a multi-group finding closes on.
     */
    groupReview?: (turn: GroupReviewTurn) => GroupReview | string;
    /**
     * The group review's fix certificate, the same rule as {@link CrewOptions.screenFixes}: the default
     * certifies every task the prompt named as `resolved`, quoting the first group's installed text.
     */
    groupFixes?: (turn: GroupReviewTurn) => SampledFixVerification[];
    /**
     * SUMMARY PHRASE R3 — the `group_refs` the deep-review Critic files its finding with. The default
     * names every group of the Story: on a group-managed book the Reader REFUSES a phase-① Summary
     * defect that names none (`tools/reader.ts`), and "the whole Overview" is the honest reading of a
     * crew that reports a defect without scoping it. A slice that wants the work routed to ONE group
     * resolves that id from `ctx.store.phraseGroups` and returns it; returning `[]` opts back into the
     * legacy meaning on a legacy book.
     */
    criticGroupRefs?: (ctx: CrewContext) => string[] | undefined;
    /**
     * PHRASE ② (T-W2) — the chapter count the Editor's `structurePlotlines` call declares. A slice names
     * one to pin the materialized set (`3` → `chapter_1..chapter_3`); otherwise the crew answers with the
     * Author's declared `summaries.chapter_count`, which is the number the classic phase-② pipeline would
     * have written the same number of contracts for.
     */
    plotlineChapters?: (ctx: CrewContext) => number;
    /**
     * READER SCORING (D-65) — the JSON a `score_sections` run answers. The default scores EVERY group
     * the prompt printed, one deterministic number per group, so a slice can pin the five
     * `summary_scores` rows exactly rather than read whatever the mock invented. Return a STRING to
     * answer raw text (the schema-repair rows), or an answer that skips a group / names an id outside
     * the Overview: that is a refusal the whole run pays for
     * (`phrase/section-scores.ts:parseSectionScoreAnswer`), which is how a slice drives D-65's
     * completeness gate.
     */
    sectionScores?: (turn: SectionScoreTurn) => SectionScores | string;
    /**
     * PHRASE ② (T-W2) — the JSON a chapter `draft_groups` run answers. The prompt is Phrase ②'s, and the
     * contract is `ChapterDraft`: one entry per CHAPTER group the prompt printed, each entry that
     * chapter's plotpoints rather than its prose. The default answers every group the prompt named with
     * text derived from the entry's KEY (`chapter_2`) and the phrase seed, so an installed contract
     * provably came from the prompt that asked for it — the guarantee `defaultGroupDraftAnswer` gives a
     * Summary group, restated for plotpoints because `phrase/plotpoints.ts:parseChapterDraftAnswer`
     * refuses an entry whose `must_happen`/`must_change` are blank. Return a STRING to answer raw text
     * (the schema-repair rows), or an answer that skips a group / names a ref outside the batch: that is
     * a refusal the whole batch pays for, which is how a slice drives R2's all-or-none install on the
     * chapter lane.
     */
    chapterDraft?: (turn: ChapterDraftTurn) => ChapterDraft | string;
}

/**
 * The compiled prompt a chapter `draft_groups` run receives (T-W2): Phrase ②'s seed, the chapter
 * contracts as they stand, and the fix list. Same shape as {@link GroupDraftTurn} — the batch is the
 * groups the prompt printed, whatever phrase they belong to.
 */
export interface ChapterDraftTurn {
    groups: GroupPromptEntry[];
    system: string;
    user: string;
    prompt: string;
}

/** The compiled prompt a `score_sections` run receives (D-65): the whole Overview, no fix list. */
export interface SectionScoreTurn {
    /** The sections the prompt printed, parsed from its own headings — the ids the answer must carry. */
    groups: GroupPromptEntry[];
    system: string;
    user: string;
    prompt: string;
}

/** The compiled prompt a no-tool sampling run receives (§5); no brief exists in this mode. */
export interface SampleTurn {
    /** 1-based sample index the Work Item set as the provider `seed` (§6.4 step 3). */
    sampleIndex: number;
    system: string;
    user: string;
    prompt: string;
}

/** The compiled prompt a no-tool screening run receives (§5), with its target draft resolved. */
export interface ScreenTurn {
    /** 1-based sample index parsed from the target draft's `premise` line; 0 when unknown. */
    sampleIndex: number;
    /** The stored revision the target draft is, when it can be resolved; '' otherwise. */
    revisionId: string;
    /** The `## TARGET DRAFT` block, verbatim. */
    draft: string;
    /**
     * H1 — the fix task ids this pass's `## FIX TASKS` section names, in prompt order. Empty for a
     * round-1 screen. A scripted `screenAnswer`/`screenFixes` uses these to build a certificate, and
     * the engine grades the candidate against exactly this list (`WorkItem.fixRefs`).
     */
    fixIds: string[];
    system: string;
    user: string;
    prompt: string;
}

/**
 * SUMMARY PHRASE — one group exactly as a group prompt prints it (`run/phase1-prompt.ts:renderGroupEntry`).
 *
 * THE HEADING IS THE INTERFACE: `group_ref` is the id the answer has to carry and the id the engine writes
 * against, so a scripted answer reads its groups back out of the same bytes a model would, rather than
 * being handed a fixture's private list. `currentText` is what a FIX has to revise; it is `''` for a group
 * the prompt says was never written, because there is nothing there to keep.
 */
export interface GroupPromptEntry {
    ref: string;
    key: string;
    revision: number;
    currentText: string;
}

/** The compiled prompt a `draft_groups` run receives (R2): the batch's groups, in catalog order. */
export interface GroupDraftTurn {
    groups: GroupPromptEntry[];
    system: string;
    user: string;
    prompt: string;
}

/** The compiled prompt a `review_groups` run receives (R3): the whole Overview, plus its fix list. */
export interface GroupReviewTurn {
    groups: GroupPromptEntry[];
    /** The fix ids this pass's `## FIX TASKS` section names; empty when the pass carries none (H1/R2). */
    fixIds: string[];
    system: string;
    user: string;
    prompt: string;
}

// The criteria the engine aggregates over the Story row rather than the artifact: C-4's subject is
// the whole set, and C-10/C-11/C-13 are whole-level checks (`criteria/engine.ts:scopeTargets`).
export const STORY_SCOPED_CRITERIA = ['C-4', 'C-10', 'C-11', 'C-13'];

/**
 * SUMMARY PHRASE — the groups a GROUP prompt prints, read back out of its `### …` headings
 * (`run/phase1-prompt.ts:renderGroupEntry`). This is a PARSER and not a fixture list on purpose: the
 * mock crew answers a group job from the same bytes a real model would read, so a slice that scripts a
 * fix over `premise` addresses the id the prompt actually offered, and a prompt that stopped printing
 * ids produces an empty batch here exactly as it would leave a real model nothing to copy.
 *
 * The current text is the paragraph under `current text:` up to the blank line that ends the entry — the
 * entry boundary and the instruction block that follows it both open with a blank line, so stopping
 * there keeps the engine's answer contract out of the group's text.
 */
function groupEntriesOf(prompt: string): GroupPromptEntry[] {
    // `key=[a-z0-9_]+`: the Summary's five keys are letters (`premise`, `overview`, …), and Phrase ②'s
    // are `chapter_1`…`chapter_N` (T-W2) — a letters-only class silently parsed nothing for a chapter
    // batch, which would leave the mock answering an empty batch and every chapter job refused.
    const heading = /^### .+ \(group_ref=([^,]+), key=([a-z0-9_]+), revision=(\d+)\)$/gm;
    const entries: GroupPromptEntry[] = [];
    let match: RegExpExecArray | null;

    while ((match = heading.exec(prompt)) !== null) {
        const block = prompt.slice(match.index + match[0].length);
        const marker = block.indexOf('current text:');
        const rest = marker === -1 ? '' : block.slice(marker + 'current text:'.length);
        const text = rest.split('\n\n')[0]?.trim() ?? '';

        entries.push({
            ref: match[1].trim(),
            key: match[2],
            revision: Number(match[3]),
            // The stated absence is not a text: an unwritten group has nothing to revise (R2).
            currentText: text.startsWith('(this group has never been written') ? '' : text
        });
    }

    return entries;
}

/**
 * The default `draft_groups` answer (R2): one entry per group the prompt named, in that order, content
 * derived from the group's KEY and the Seed's logline. `sample N: <logline>` is the sampler's traceability
 * guarantee; this is its group equivalent — an installed group says which group it is and came from the
 * prompt that asked for it, and five different texts make a batch that wrote only two of them visible.
 */
export const defaultGroupDraftAnswer = (
    groups: readonly GroupPromptEntry[],
    logline: string,
    knowledgeUsed: string[] = []
): GroupDraft => ({
    groups: groups.map((group) => ({ group_ref: group.ref, content: `${group.key}: ${logline}` })),
    knowledge_used: knowledgeUsed
});

/**
 * The phrase seed this Story's phrase prompt printed (`## PHRASE SEED`, T-W2). The compiler renders the
 * phrase's own text — the lines Phrase ② resolves into chapters — so the first content line is the
 * chapter set's subject, and quoting it is the mock's proof that its answer came from THIS prompt rather
 * than from a fixture. `## SEED BRIEF`'s `logline:` line is the phase-① equivalent (`loglineOf`).
 */
const phraseSeedLineOf = (prompt: string): string => {
    const section = /## PHRASE SEED[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(prompt)?.[1] ?? '';
    const line = section
        .split('\n')
        .map((entry) => entry.replace(/^[-*]\s*/, '').trim())
        .find((entry) => entry !== '' && !entry.startsWith('('));

    return line === undefined ? 'the phrase seed' : line;
};

/**
 * The default `ChapterDraft` answer (T-W2): one entry per chapter group the prompt named, in that order,
 * every plotpoint field filled from the entry's KEY and the phrase seed. All five fields are filled
 * rather than only the two required ones because the chapter's `plotlines` mirror is written from the
 * answer's plotpoints (`phrase/plotpoints.ts:syncPlotlineContract`), and a contract with a blank `pov`
 * or `payoffs` is a contract the C-5/C-6 payoff criteria then measure against an empty field — the
 * slice would be testing the mock's shorthand, not the lane.
 */
export const defaultChapterDraftAnswer = (
    groups: readonly GroupPromptEntry[],
    seed: string,
    knowledgeUsed: string[] = []
): ChapterDraft => ({
    groups: groups.map((group) => ({
        group_ref: group.ref,
        heading: group.key.replace(/_/g, ' '),
        must_happen: `${group.key} must deliver: ${seed}`,
        must_change: `${group.key} leaves the book different: ${seed}`,
        pov: `${group.key} is told through the protagonist`,
        setups: `${group.key} plants: ${seed}`,
        payoffs: `${group.key} pays off: ${seed}`
    })),
    knowledge_used: knowledgeUsed
});

/**
 * READER SCORING (D-65) — the default `SectionScores` answer, one entry per section the prompt printed.
 *
 * THE NUMBERS ARE A PURE FUNCTION OF THE PROMPT, which is what makes them assertable: `60 + 8 × position`
 * (premise 60, promise 68, theme 76, tone 84, ending 92), so a slice pins all five scores exactly and a
 * second run over the same Overview answers identically. The evidence line is the group's OWN current
 * text, quoted from the prompt the engine compiled — the same guarantee `defaultGroupDraftAnswer` gives
 * the Writer: a stored row provably came from the bytes that asked for it, and a parse that requires a
 * non-empty quote (D-15) never sees a mock invent one.
 */
export const SECTION_SCORE_BASE = 60;
export const SECTION_SCORE_STEP = 8;

export const defaultSectionScoreAnswer = (groups: readonly GroupPromptEntry[]): SectionScores => ({
    sections: groups.map((group, index) => ({
        group_ref: group.ref,
        score: SECTION_SCORE_BASE + index * SECTION_SCORE_STEP,
        rationale: `${group.key} holds together as written and is contradicted by none of the other sections (revision ${group.revision})`,
        evidence: (group.currentText.trim().split('\n')[0] ?? '').trim() || `${group.key}: (no current text)`
    }))
});

/**
 * The Seed Brief the scripted Editor derives (§1 step 2, §3.3). Every field is a pure function of
 * the Seed text, so a test can pin the record exactly and a second Story with the same Seed gets
 * the same brief. The Seed itself is never written (P5): these are the DERIVED projection's words.
 *
 * D-51: `research_questions` is a REQUIRED arg of `structureSeed`, and these integration rows run
 * the REAL tool over HTTP — an omitted field would be a T-11 refusal and no Story would ever reach
 * sampling. The scripted Editor states ONE question, which keeps the phase-① slices dispatching their
 * Researcher (`wi_research_1` closes, and the samples wait for it). A script that wants the waiver
 * overrides the spread with its own `research_questions: []` in the `structureSeed` args.
 */
export const seedBriefFields = (seed: string) => {
    const logline = (seed.split('\n')[0] ?? '').trim();

    return {
        logline,
        protagonist: `the protagonist of: ${logline}`,
        want: 'to keep the promise the Seed makes',
        obstacle: 'what the Seed puts between the protagonist and the want',
        stakes: 'what the Seed says is lost if the want fails',
        setting: 'the place and time the Seed names',
        world_rules: [`the Seed is law (P5): ${logline}`],
        promise: `the book pays the promise "${logline}" makes`,
        tone_hints: 'as the Seed tells it',
        constraints: [] as string[],
        open_questions: [] as string[],
        research_questions: [`what outside fact does "${logline}" depend on that the Seed does not state`]
    };
};

/** The Seed text the compiled brief carries — parsed from the SEED section, never from `story[0]`. */
const seedOfBrief = (brief: string): string =>
    (/^# SEED — Author truth[^\n]*\n([^\n]*)/m.exec(brief)?.[1] ?? '').trim();

/** A chapter's prose, distinguishable per chapter and per draft, so `toEqual` on bodies is meaningful. */
export const chapterProse = (order: number, note = ''): string =>
    `Chapter ${order}. Wren reaches the ${order}th gallery and the lamp answers with a voice she half remembers.${note}`;

/** A Plotline contract in §4.3's shape, one per order. */
export const plotlineContract = (order: number) => ({
    order,
    heading: `The ${order}th gallery`,
    must_happen: `The lamp tests Wren in the ${order}th gallery.`,
    must_change: `Wren loses one memory climbing the ${order}th gallery.`,
    pov: 'Wren'
});

// ---------------------------------------------------------------------------
// Reading a brief the way a model does
// ---------------------------------------------------------------------------

/** The tool messages of the turn the model is answering. */
const toolResults = (request: ChatRequest): Array<Record<string, unknown>> =>
    request.messages
        .filter((message) => message.role === 'tool')
        .map((message) => {
            try {
                return JSON.parse(String(message.content ?? '{}')) as Record<string, unknown>;
            } catch {
                return { raw: message.content };
            }
        });

/**
 * The calls of the assistant turn the model is answering, so a refusal can be re-acted to. The wire
 * transcript DOES carry `tool_calls` on its assistant entries (`llm/client.ts:AssistantMessage`),
 * but the narrowed `ChatMessage` type used for a request omits them, hence the read-through cast.
 */
function lastToolCalls(request: ChatRequest): Array<{ name: string; arguments: string }> {
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
        const message = request.messages[index] as unknown as {
            role: string;
            tool_calls?: Array<{
                name?: string;
                arguments?: string;
                function?: { name?: string; arguments?: string };
            }>;
        };
        if (message.role !== 'assistant') continue;

        // The assistant wire shape nests name/arguments under `function` (the OpenAI schema the
        // provider receives); a fixture double may also see the engine's flat form in a unit
        // test, so both readings name the same call.
        return (message.tool_calls ?? []).map((call) => ({
            name: call.name ?? call.function?.name ?? '',
            arguments: call.arguments ?? call.function?.arguments ?? ''
        }));
    }

    return [];
}

/** Looks up the row a refused write was racing, so the retry can send the CURRENT rev (T-4). */
function revOf(store: Store, id: string): number | undefined {
    for (const collection of ['stories', 'summaries', 'plotlines', 'chapters'] as const) {
        const row = (store[collection] as { get(id: string): { rev?: number } | undefined }).get(id);
        if (row) return row.rev;
    }

    return undefined;
}

/**
 * Everything the brief says about who is being judged. The headings are the shipped ones:
 * `run/brief.ts` renders `ROLE — <role> (<kind>) of <template>`, `Phase: <phase>.`,
 * `ARTIFACT UNDER REVIEW — ...`, the criteria as `- C-4 · HARD · ...` lines, the drafts as
 * `revision_id=...`, and the named findings/Ideas as `- finding_1 [...]` / `- idea_1 [...]`.
 */
function readBrief(brief: string, store: Store, options: CrewOptions) {
    const role = /^# ROLE — (\S+) \((\w+)\) of (\S+)$/m.exec(brief);

    // The unit named in the heading resolves back to its Story; a whole-Story job falls back to the
    // only Story the fixture has, and the first one when a queue test has two.
    const unitRef =
        /chapter_(\d+)/.exec(brief)?.[0] ?? /plotline_(\d+)/.exec(brief)?.[0] ?? /summary_(\d+)/.exec(brief)?.[0];
    const ownerOf = (id: string | undefined): Story | undefined => {
        if (!id) return undefined;
        const storyId =
            store.chapters.get(id)?.story_id ??
            store.plotlines.get(id)?.story_id ??
            store.summaries.get(id)?.story_id ??
            store.stories.get(id)?.id;

        return storyId ? store.stories.get(storyId) : undefined;
    };

    const story = ownerOf(unitRef) ?? store.stories.list()[0];
    const summary = store.summaries.list().find((row) => row.story_id === story?.id);

    // A criterion the brief marks "server-checked" is the engine's own, so the crew cannot pass or
    // fail it with a line; only the `you judge it` criteria get verdict lines.
    const criteria = [...brief.matchAll(/^- (C-\d+) · (HARD|soft) · (you judge it|server-checked[^\n]*)/gm)]
        .filter((match) => match[3].startsWith('you judge it'))
        .map((match) => match[1])
        .filter((id) => !options.omitCriteria?.includes(id));

    // PHRASE ② (T-W2b) — THE HEADING IS THE TARGET. `run/brief.ts:artifactHeading` names the unit's id
    // explicitly (`ARTIFACT UNDER REVIEW — plotline plotline_0 — chapter 1 (order 1)`), and it is the one
    // place the product states what this job judges. The free-text scan used to run first, and a
    // group-managed book's ARTIFACT body now carries the lane's mirrored contract text, which begins with
    // the chapter ENTRY key (`chapter_1 must deliver: …` — `phrase/plotpoints.ts:syncPlotlineContract`).
    // So a phase-② reader on such a book filed its UNIT-scoped lines at `chapter_1` — a phrase GROUP key,
    // not a §4 row — `submitVerdict` refused it (T-3), only the story-scoped line landed, and the chapter
    // level stalled at 5/7 with C-2/C-3 never judged. The heading wins; the scan stays as the fallback for
    // briefs that carry no heading (the structured, tool-less seats).
    const headingTarget = /ARTIFACT UNDER REVIEW — (?:plotline|chapter|summary) ((?:plotline|chapter|summary|story|revision)_[^\s—]+)/.exec(
        brief
    )?.[1];

    const unitTarget =
        /summary_id=(\S+)/.exec(brief)?.[1] ??
        headingTarget ??
        /chapter_(\d+)/.exec(brief)?.[0] ??
        /plotline_(\d+)/.exec(brief)?.[0] ??
        summary?.id ??
        story?.id;

    const phase = /Phase: (\w+)\./.exec(brief)?.[1] ?? story?.phase ?? 'summary';
    // PHRASE ② (T-W2) — the chapter lane's deep review, recognized from the bytes the product writes.
    // `loop/work.ts:phase2GroupCandidates` gives the seat NO unit (`unit: undefined` — the chapter contract
    // set is not one row), so the only thing that says what this pass is judging is its sweep note:
    // `Critic pass N/M on the installed chapter contracts at vector <hash> …` (brief.ts renders the note
    // under "The sweep's note on this job:"). Keyed on the note, never on a flag, and gated on the phase so
    // a Summary-phase brief can never read as a chapter pass.
    const chapterPass =
        phase === 'plotlines' && /Critic pass \d+\/\d+ on the installed chapter contracts at vector/.test(brief);

    return {
        kind: role?.[2] ?? '',
        template: role?.[3] ?? '',
        story,
        summary,
        summaryId: summary?.id,
        unitTarget,
        criteria,
        directiveRef: /Directive (directive_\d+) \[/.exec(brief)?.[1],
        directiveTargets: (() => {
            const line = /The server resolved the sentence to these artifacts: ([^\n]+)\./.exec(brief)?.[1];

            return line === undefined ? [] : line.split(',').map((ref) => ref.trim());
        })(),
        draftIds: [...brief.matchAll(/revision_id=(revision_\d+)/g)].map((match) => match[1]),
        findingIds: [...brief.matchAll(/^- (finding_\d+) \[/gm)].map((match) => match[1]),
        ideaIds: [...brief.matchAll(/^- (idea_\d+) \[/gm)].map((match) => match[1]),
        taskIds: [...brief.matchAll(/^- (task_\d+) \[/gm)].map((match) => match[1]),
        // TWO job-note shapes mean "this is phase ①'s deep review", spelled the way `loop/work.ts` spells
        // them TODAY: the sampling pipeline's `Critic pass N/M on the selected Summary draft <revision>`
        // (`work.ts:1673`, §6.4 step 6) and the group pipeline's `Critic pass N/M on the installed group
        // Overview at vector <hash>` (`work.ts:1345`, R3/R5). The legacy `Critic pass N of M` spelling is
        // kept as a third alternative because the two families are the ONLY notes that use the phrase, and
        // a double that stops matching the note the product writes is invisible: the review run files no
        // verdict and no finding (`criticFinds` never runs), the Summary level looks passed on the probe
        // rows alone, and every round-2 row behind it silently disappears.
        reviewPass:
            /Critic pass \d+ of \d+/.test(brief) ||
            // PHRASE ② (T-W2): the chapter lane's deep review is the same KIND of pass — a tool-carrying
            // Critic that files real findings — and `loop/work.ts:phase2GroupCandidates` spells its note
            // `Critic pass N/M on the installed chapter contracts at vector <hash>`. Without this
            // alternative the double answers the seat as if it were an Idea probe: no verdict line, no
            // finding, and the chapter level looks passed on the mechanical rows alone.
            /Critic pass \d+\/\d+ on the (?:selected Summary draft|installed group Overview|installed chapter contracts)/.test(
                brief
            ),
        /**
         * True only for Phrase ②'s chapter-contract pass. The crew needs it because the artifact shape
         * differs: the phase-① passes judge a draft row or the composed Overview (both one row, both a
         * `target_ref` the crew can name), while the chapter seat judges a SET of contracts and files at
         * the STORY row — the scope `criteria/engine.ts:scopeTargets` grades the phase-② level on.
         */
        chapterPass,
        phase
    };
}
// ---------------------------------------------------------------------------
// The Reader's report
// ---------------------------------------------------------------------------

/**
 * One verdict line per briefed criterion, filed at the scope the engine aggregates over. `submitVerdict`
 * takes one `target_ref` (§8.3) and `criteria/engine.ts:passingFor` counts a line only when its
 * target equals the scope the criterion needs — so a double that filed everything at the artifact
 * could never complete a level, which is the bug §15 exists to catch (see also tools/reader.ts).
 */
function verdictCalls(ctx: CrewContext, evidence: string): CrewCall[] {
    const { criteria, unitTarget, story, options } = ctx;

    const line = (id: string) => ({
        criterion: id,
        result: !options.failCriteria?.includes(id),
        evidence: options.failCriteria?.includes(id) ? `${evidence} — ${id} fails here.` : evidence
    });

    const storyLines = criteria.filter((id) => STORY_SCOPED_CRITERIA.includes(id)).map(line);
    const unitLines = criteria.filter((id) => !STORY_SCOPED_CRITERIA.includes(id)).map(line);
    const target = unitTarget ?? story?.id ?? '';

    const out: CrewCall[] = [];

    // `recommendation` is a `z.enum` over `advance | fix | stuck` (tools/reader.ts) — never `done`.
    const failing = criteria.filter((id) => options.failCriteria?.includes(id)).length;

    if (unitLines.length || storyLines.length === 0)
        out.push({
            name: 'submitVerdict',
            args: {
                target_ref: target,
                criteria_passed: unitLines,
                recommendation: unitLines.some((entry) => entry.result === false) ? 'fix' : 'advance'
            }
        });
    if (storyLines.length)
        out.push({
            name: 'submitVerdict',
            args: {
                target_ref: story?.id ?? target,
                criteria_passed: storyLines,
                recommendation: failing ? 'fix' : 'advance'
            }
        });

    return out;
}

// ---------------------------------------------------------------------------
// The crews, per §8.1
// ---------------------------------------------------------------------------

/** The Writer crew: expand the Summary, contract the Plotlines, draft the Chapters. */
const writerScript: CrewScript = (ctx) => {
    const { store, story, summary, summaryId, unitTarget, results } = ctx;

    // A second turn exists only to answer what the tool layer said. A create's CAS rides on the
    // Story row (writer.ts: `expectsFor(expects, ctx.storyId)`), so the honest re-apply is to re-read
    // which orders exist NOW and send the ones that are still missing, with the rev in hand.
    if (results.length > 0) {
        const raced = ctx.refusals.find((refusal) => refusal.refused === 'T-4' || refusal.refused === 'T-11');
        const original = lastToolCalls(ctx.request)[0];

        if (raced && original && ctx.template === 'writer-plotlines') {
            const planned = store.plotlines.list().filter((row) => row.story_id === story?.id);
            const wanted = Math.max(1, summary?.chapter_count ?? 3);
            const missing = Array.from({ length: wanted }, (_, index) => index + 1).filter(
                (order) => !planned.some((row) => row.order === order)
            );

            if (!missing.length) return { content: `The contract set is complete (${ctx.template}).` };

            return {
                toolCalls: missing.map((order) => ({
                    name: 'createPlotline',
                    args: {
                        ...plotlineContract(order),
                        ...(story ? { expects: [{ id: story.id, rev: revOf(store, story.id) ?? 0 }] } : {}),
                        why: 'Re-applied against the rev the refusal handed back (T-4: a create rides on the Story row).'
                    }
                }))
            };
        }

        if (raced && original) {
            const args = { ...(JSON.parse(original.arguments || '{}') as Record<string, unknown>) };
            const targetId = String(
                args.chapter_id ?? args.plotline_id ?? args.unit_ref ?? summaryId ?? story?.id ?? ''
            );

            args.expects = [{ id: targetId, rev: revOf(store, targetId) ?? 0 }];
            args.why = 'Re-applied against the rev the refusal handed back (T-4).';

            return { toolCalls: [{ name: original.name, args }] };
        }

        // Any other refusal: report what happened and stop — a real crew writes nothing further.
        return { content: `Reported after ${ctx.refusals.length} refusal(s) (${ctx.template}).` };
    }

    if (ctx.template === 'writer-plotlines') {
        const planned = store.plotlines.list().filter((row) => row.story_id === story?.id);
        // D-3b: `chapter_count` is Author truth and it lives on the Summary row, not the Story.
        const wanted = Math.max(1, summary?.chapter_count ?? 3);
        const missing = Array.from({ length: wanted }, (_, index) => index + 1).filter(
            (order) => !planned.some((row) => row.order === order)
        );

        return {
            toolCalls: [
                ...missing.map((order) => ({
                    name: 'createPlotline',
                    args: { ...plotlineContract(order), why: `The chapter contract for order ${order} (C-3).` }
                })),
                ...verdictCalls(ctx, 'Probe: contracts written from the locked Summary.')
            ]
        };
    }

    if (ctx.template === 'writer-chapters') {
        const chapter = store.chapters.get(String(unitTarget ?? ''));

        if (!chapter) {
            const order = Number(
                /ARTIFACT UNDER REVIEW — chapter \S+ \(order (\d+)/.exec(ctx.request.messages[0]?.content ?? '')?.[1] ??
                    '1'
            );
            const plotline = store.plotlines.list().find((row) => row.story_id === story?.id && row.order === order);

            return {
                toolCalls: [
                    {
                        name: 'createChapter',
                        args: {
                            plotline_id: plotline?.id,
                            title: `Chapter ${order}`,
                            summary: `The ${order}th gallery.`,
                            why: 'Instantiate the chapter for its contract (C-1).'
                        }
                    }
                ]
            };
        }

        return {
            toolCalls: [
                {
                    name: 'editChapter',
                    args: {
                        chapter_id: chapter.id,
                        rewrite: true,
                        content: chapterProse(chapter.order),
                        // A chapter already holding prose is a second pass, so the draft competes (D-3d).
                        ...(chapter.sections.length > 0 ? { title: chapter.title } : {}),
                        expects: [{ id: chapter.id, rev: chapter.rev }],
                        why: `Prose for chapter ${chapter.order} (C-7, C-8).`
                    }
                },
                ...verdictCalls(ctx, `Probe: the prose delivers crossing ${chapter.order}.`)
            ]
        };
    }

    // A writer template the built-in set does not define still has to report against its unit.
    return { toolCalls: [...verdictCalls(ctx, `Probe: ${ctx.template} reports against its unit.`)] };
};

/**
 * The Editor crew: select the best draft (§6.4/L-17), verify the findings and Ideas in front of it
 * (D-33/D-27). One select job carries the drafts the Writers filed; `selectRevision` names exactly
 * one of them (D-3b gives the Editor sole selection authority, and T-2a requires the note to name
 * the rule).
 */
const editorScript: CrewScript = (ctx) => {
    const brief = String(ctx.request.messages[0]?.content ?? '');
    const { draftIds, findingIds, ideaIds } = readBrief(brief, ctx.store, ctx.options);

    // D-19's directive review: the Author talks to the Editor, and the Editor turns the direction
    // into the queue. The server resolved the affected artifacts, so the review names one task per
    // artifact — exactly what a model reads out of the same brief.
    if (ctx.directiveRef !== undefined) {
        if (ctx.results.length > 0) return { content: `Queued the directive's work (${ctx.template}).` };

        return ctx.directiveTargets.length === 0
            ? { content: `No artifact resolved for ${ctx.directiveRef}; nothing to queue.` }
            : {
                  toolCalls: ctx.directiveTargets.map((ref) => ({
                      name: 'createTask',
                      args: {
                          title: `propagate: ${ctx.directiveRef}`,
                          detail: `${ctx.directiveRef} · ${ref}`,
                          owner_role: 'writer',
                          priority: 1,
                          why: `the Editor turned the Author's directive onto ${ref} (D-19, D-11)`
                      }
                  }))
              };
    }

    // PHRASE ② T-W2 — the chapter structuring pass. Same two-turn shape as phase ①'s structure pass,
    // with two differences the brief forces:
    //
    //   1. there is nothing to READ first. Phase ① reads the Seed because `stories.idea` is behind a tool
    //      (`readSeed`); Phrase ②'s seed is the PHRASE's copied text, and `work.ts:phase2GroupCandidates`
    //      prints it — with its `seed_hash` — inside the job note, because the tool refuses a hash it did
    //      not print (P5, one phrase down). So the crew takes the hash out of the bytes it was handed,
    //      exactly as a model would, and calls the tool once.
    //   2. the chapter count is a decision, not a transcription (D-3b). A real Editor chooses it from the
    //      seed; this scripted crew answers with `CrewOptions.plotlineChapters` when the slice names one
    //      and with the Author's declared `summaries.chapter_count` otherwise — the same number the
    //      classic phase ② pipeline would have written contracts for, which is what keeps a lane switch
    //      from silently changing the book's shape.
    if (ctx.template === 'editor-plotlines-structure') {
        const hash = /seed_hash=([0-9a-f]{6,})/.exec(brief)?.[1];

        if (hash === undefined) {
            return { content: `The structure job printed no seed_hash to answer (brief:\n${brief.slice(0, 240)}…)` };
        }

        if (ctx.results.length === 0) {
            const declared = ctx.store.summaries.get(ctx.story?.id ?? '')?.chapter_count;
            const chapter_count = ctx.options.plotlineChapters?.(ctx) ?? (typeof declared === 'number' ? declared : 3);

            return {
                toolCalls: [
                    {
                        name: 'structurePlotlines',
                        args: {
                            seed_hash: hash,
                            chapter_count,
                            why: 'The chapter set is the seed read as chapters — the count it resolves into, nothing invented (P5, D-3b).'
                        }
                    }
                ]
            };
        }

        const failed = ctx.results.find((result) => result.ok === false) as { refused?: string } | undefined;

        return failed === undefined
            ? { content: `Structured the phrase seed into its chapter set (${ctx.template}).` }
            : { content: `structurePlotlines refused (${failed.refused ?? 'T-11'}); nothing to retry from here.` };
    }

    // §6.4 step 1: the Editor's structure pass reads the Seed for its `seed_hash` and then writes
    // the DERIVED brief. Two turns, exactly as the template's prompt instructs: readSeed first,
    // structureSeed second — the tool refuses a hash that does not name the Seed as it stands (P5).
    //
    // The job is identified by its TEMPLATE: `work.ts:phase1PipelineCandidates` binds the structure
    // pass to `editor-seed-structure` explicitly, and every unbound Editor job (`verify_findings`,
    // `verify_ideas`, `directive_work`, `select`) binds the first assigned Editor — which
    // `templates.ts:DEFAULT_ASSIGNMENT` makes `editor-general`. Keying on the brief's artifact
    // heading would keep masking a regression of that assignment order; keying on the template
    // makes a mis-bound verification fail the slice loudly instead of answering with a Seed read.
    if (ctx.template === 'editor-seed-structure') {
        const seed = seedOfBrief(brief);

        if (ctx.results.length === 0) return { toolCalls: [{ name: 'readSeed', args: {} }] };

        // `readSeed` returns the hash in `data.seed_hash`; a missing one means the read refused, and
        // sending '' would only make composition fail a second time. Report instead of guessing.
        const hash = ctx.results
            .map((result) => (result.data as Record<string, unknown> | undefined)?.seed_hash)
            .find((value): value is string => typeof value === 'string' && value.length > 0);

        if (hash === undefined || seed === '') {
            return { content: `The Seed read did not name a hash to structure against (${ctx.template}).` };
        }

        return {
            toolCalls: [
                {
                    name: 'structureSeed',
                    args: {
                        seed_hash: hash,
                        ...seedBriefFields(seed),
                        why: 'The brief restates the Seed and invents nothing (P5, D-17c).'
                    }
                }
            ]
        };
    }

    // The second turn of a session exists only to answer what the tool layer said. Anything other
    // than a fixable refusal is reported and dropped — the loop has no turn cap (E-0), so a crew
    // that re-issued a call it had already been refused would spin until the heap ran out.
    if (ctx.results.length > 0) {
        const failed = ctx.results.find((result) => result.ok === false) as
            | { refused?: string; issues?: Array<{ field?: string }> }
            | undefined;

        // T-9 is "you kept nobody": the honest answer is to keep the best draft still on the book.
        if (failed?.refused === 'T-9') {
            const kept = ctx.store.revisions
                .list()
                .filter(
                    (revision) =>
                        revision.story_id === ctx.story?.id &&
                        (revision.state === 'drafted' || revision.state === 'competing')
                );

            return kept.length
                ? {
                      toolCalls: [
                          {
                              name: 'selectRevision',
                              args: {
                                  unit_ref: kept[0].unit_ref,
                                  revision_id: kept[kept.length - 1].id,
                                  selection_note:
                                      'After the T-9 refusal: the draft that carries the most of the Summary rule wins (L-17).'
                              }
                          }
                      ]
                  }
                : { content: `Nothing left to choose (${ctx.template}).` };
        }

        // A T-11 naming `unit_ref` is a shape mistake the Editor can fix from the row it can see.
        if (failed?.refused === 'T-11' && failed.issues?.some((issue) => issue.field === 'unit_ref')) {
            const draft = ctx.store.revisions
                .list()
                .find(
                    (revision) =>
                        revision.story_id === ctx.story?.id &&
                        (revision.state === 'drafted' || revision.state === 'competing')
                );

            return draft
                ? {
                      toolCalls: [
                          {
                              name: 'selectRevision',
                              args: {
                                  unit_ref: draft.unit_ref,
                                  revision_id: draft.id,
                                  selection_note: 'Re-sent with the unit the draft itself names (T-11 fix).'
                              }
                          }
                      ]
                  }
                : { content: `No competing draft to select (${ctx.template}).` };
        }

        return { content: `Reported after ${ctx.refusals.length} refusal(s) (${ctx.template}).` };
    }

    const specs: CrewCall[] = [];

    if (draftIds.length > 0) {
        specs.push({
            name: 'selectRevision',
            args: {
                unit_ref: ctx.unitTarget,
                revision_id: draftIds[0],
                selection_note: 'The rule from the template: the draft that names its price earliest wins (L-17).'
            }
        });
    }

    for (const id of findingIds) {
        specs.push({
            name: 'verifyFinding',
            // D-33 quick check: mark it valid and give the reason; the Critic's cost stands unless
            // the Editor deliberately corrects it.
            args: {
                finding_id: id,
                verdict: 'confirmed',
                why: 'D-33 verification: the cited passage shows the defect.'
            }
        });
        // Phase ①'s approval, in the same granular thread. The deep review's tool-using Critic is
        // already the independent read, so the Editor's verification is what arms the next sampling
        // round (§6.4 step 6). Phase ① approves only critical/major; a minor/taste note is recorded,
        // never turned into work.
        const finding = ctx.store.findings.get(id);
        const covered = finding !== undefined && (ctx.story?.auto_approve ?? []).includes(finding.cost);

        if (
            ctx.phase !== 'summary' ||
            (finding !== undefined && (finding.cost === 'critical' || finding.cost === 'major'))
        ) {
            if (covered) {
                specs.push({
                    name: 'approveFinding',
                    args: {
                        finding_id: id,
                        decision: 'auto',
                        why: 'The Story dial covers the confirmed finding; the Critic confirms it independently.'
                    }
                });
            }
        }
    }

    for (const id of ideaIds) {
        specs.push({
            name: 'verifyIdea',
            args: {
                idea_id: id,
                // D-27: a refuted Idea leaves the tray without ever reaching the Author's decision.
                verdict: ctx.options.refuteIdeas ? 'refuted' : 'verified',
                evidence: 'Probe: re-read the cited source, which says exactly this.',
                meets_guidelines: true,
                why: 'D-27 verification.'
            }
        });
    }

    if (!specs.length) return { content: `Nothing to choose (${ctx.template}).` };

    return { toolCalls: specs };
};

/**
 * The Researcher crew (§6.4 step 2, §7.2): read the Knowledge already recorded, then write one
 * sourced entry per claim. Two turns, exactly as `researcher-story`'s prompt instructs: a topic
 * that is already covered is refreshed, never duplicated (D-16).
 */
const researcherScript: CrewScript = (ctx) => {
    if (ctx.results.length === 0) return { toolCalls: [{ name: 'readKnowledge', args: {} }] };

    // A written entry's result carries its id (in `data` for both the create and the repeat shape).
    if (ctx.results.some((result) => typeof (result.data as Record<string, unknown> | undefined)?.knowledge_id === 'string'))
        return { content: `Reported the research pass (${ctx.template}).` };

    return {
        toolCalls: [
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
        ]
    };
};

/** The Reader crew: verdict lines for the briefed criteria, plus the optional finding and drill. */
const readerScript: CrewScript = (ctx) => {
    const unit = String(ctx.unitTarget ?? '');
    const specs: CrewCall[] = [];

    // D-35's point made visible: an unfamiliar shape is looked up with `describeTool`, not guessed.
    if (ctx.options.readerDrill && ctx.results.length === 0)
        specs.push({ name: 'describeTool', args: { name: 'submitVerdict' } });

    if (!ctx.results.some((result) => result.id || result.verdict))
        specs.push(...verdictCalls(ctx, 'Probe: judged against the contract in the brief.'));

    // The crew files the flaw once. Its judgment is scripted, so re-filing an already-repaired finding
    // every round would spin the loop forever — and the tool layer's `already_open` guard (T-10) only
    // stops a duplicate while the first one is still OPEN, not after it has been resolved.
    if (
        ctx.options.raiseFindings &&
        unit.startsWith('chapter_') &&
        !ctx.results.some((result) => result.id) &&
        ctx.store.findings.list().every((finding) => finding.story_id !== ctx.story?.id)
    ) {
        specs.push({
            name: 'raiseFinding',
            args: {
                target_ref: unit,
                criterion_ref: 'C-7',
                cost: ctx.options.raiseFindings,
                title: `Chapter ${unit.split('_')[1]} does not deliver its contract`,
                detail: 'The gallery order in the prose does not match the Plotline.',
                evidence: `the ${unit.split('_')[1]}th gallery is listed twice in the prose`,
                why: 'A contradiction the fix has to carry (D-33).'
            }
        });
    }

    return specs.length ? { toolCalls: specs } : { content: `Reported (${ctx.template}).` };
};

/** The Critic crew: the deep review (§6.4 step 6), probe Ideas (§6.7), Explorer research (D-25). */
const criticScript: CrewScript = (ctx) => {
    // The scripted crew files its Ideas ONCE per Story. A probe round on a Story whose tray was
    // just decided must not silently restock it and turn a Goal test into a tray test.
    const alreadyFiled = ctx.store.ideas.list().filter((idea) => idea.story_id === ctx.story?.id).length;
    const ideas = Math.max(0, (ctx.options.criticIdeas ?? 1) - alreadyFiled);

    if (ctx.results.length > 0) return { content: `Reported (${ctx.template}).` };

    // §6.4 step 6 — phase ①'s DEEP REVIEW: a tool-using Critic judges the selected draft against
    // the Seed, rates the Summary (the criteria engine scopes C-14 to the Summary row, not the
    // draft), and files a defect when the story's seat finds one. It proposes no Ideas — an Idea
    // is the probe round's output (D-26/D-30), and a review that also restocks the tray never closes.
    if (ctx.reviewPass) {
        // TWO targets, because the two pipelines review two different artifacts. The sampling pass is
        // briefed on a draft (`revision_id=` in its note) and D-33 makes it cite that draft; the GROUP
        // pass is briefed on the composed Overview and the Summary row, and there is NO draft row in that
        // model (`loop/work.ts`'s group deep review says so in as many words). Treating the missing draft
        // as an error is what sent the group pass down the chapter-Reader branch and left the Summary
        // level failing with no verdict and no finding at all.
        const revisionId = ctx.draftIds[0] ?? '';
        // PHRASE ② (T-W2) — the third artifact shape. Phrase ①'s two passes judge a draft row or the
        // composed Overview; the chapter lane's deep pass judges the chapter CONTRACT SET, which is not one
        // row — `work.ts:phase2GroupCandidates` deliberately gives the seat no unit (`unit: undefined`, the
        // whole-Story artifact for the phase), so `readBrief`'s `chapter_N`/`plotline_N` regex has nothing
        // real to match and `ctx.unitTarget` is a fallback id from another artifact. The engine aggregates
        // the phase-② level at the Story row (`criteria/engine.ts:scopeTargets`), so the Story id is the
        // only target that can move a level — the same reasoning that puts the Summary pass's GOAL verdict
        // on the Summary unit. `ctx.chapterPass` is read from the seat's sweep note, not from a flag.
        const chapterPass = ctx.chapterPass;
        const target = chapterPass ? (ctx.story?.id ?? '') : (ctx.unitTarget ?? revisionId);

        if (target === undefined || target === '') return { content: `No artifact named in the Critic brief (${ctx.template}).` };

        const lines = ctx.criteria.map((id) => ({
            criterion: id,
            result: !ctx.options.failCriteria?.includes(id),
            evidence: ctx.options.failCriteria?.includes(id)
                ? `the Critic pass saw the Seed element missing — ${id} fails here.`
                : 'the draft delivers this criterion against the Seed.'
        }));

        const specs: CrewCall[] = [
            {
                name: 'submitVerdict',
                args: {
                    // The GOAL verdict goes to the Summary unit: `criteria/engine.ts:scopeTargets`
                    // grades every `summary`-level criterion (C-14) on that row. This double files the
                    // decisive one of the two filings the deep-review brief now demands (CS-VERDICT-1:
                    // a Summary-unit line AND a per-draft line for U-13's panel — `loop/mock.ts`'s crew
                    // files both). It stays a valid answer on its own: the engine reads the selected
                    // draft's line as Summary evidence too (criteria/engine.ts:summaryDraftEvidenceRefs),
                    // and a unit-targeted line is the form that answers the Goal by itself.
                    target_ref: target,
                    criteria_passed: lines,
                    recommendation: lines.some((line) => !line.result) ? 'fix' : 'advance'
                }
            }
        ];

        const cost =
            typeof ctx.options.criticFinds === 'function' ? ctx.options.criticFinds(ctx) : ctx.options.criticFinds;

        if (cost !== undefined) {
            // SUMMARY PHRASE R3 — on a GROUP-managed book the Reader refuses a phase-① Summary defect
            // that names no group, because R3's closure is a join on those ids. The default copies every
            // group of the Story, which is the honest reading of a fixture that simply says "this Overview
            // has a defect" — a cross-cutting defect names them all. A slice that wants the work routed to
            // ONE group resolves that group's id from `ctx.store.phraseGroups` and returns it.
            //
            // PHRASE ② (T-W2): on the chapter pass "every group of the Story" would name the Summary's
            // five groups as well — a Story carries both phrases' rows — and a finding whose `group_refs`
            // mix phrases is planned against both entry sets, so the defect would buy a Summary rewrite
            // nobody asked for. The default is therefore the groups of the phrase the SEAT is reviewing:
            // the Plotlines phrase, whose rows are exactly the chapters the brief printed.
            const chapterPhrase = chapterPass
                ? ctx.store.phrases.list().find((row) => row.story_id === ctx.story?.id && row.key === PHRASE_PLOTLINES_KEY)
                : undefined;
            const groupRefs =
                ctx.options.criticGroupRefs !== undefined
                    ? ctx.options.criticGroupRefs(ctx)
                    : ctx.store.phraseGroups
                          .list()
                          .filter(
                              (group) =>
                                  group.story_id === ctx.story?.id &&
                                  (chapterPhrase === undefined || group.phrase_id === chapterPhrase.id)
                          )
                          .map((group) => group.id);

            specs.push({
                name: 'raiseFinding',
                args: {
                    target_ref: target,
                    // The criterion the defect is filed under: a criterion the pass actually failed, or the
                    // phase's default. C-14 is the Seed-fidelity check and is the phase-① default; the
                    // chapter pass's contract criterion is C-7 ("the chapter delivers its must_happen"),
                    // because filing a Summary criterion against a chapter contract is the row the criteria
                    // engine cannot grade (it scopes C-14 to the Summary artifact).
                    criterion_ref: lines.find((line) => !line.result)?.criterion ?? (chapterPass ? 'C-7' : 'C-14'),
                    title: chapterPass
                        ? `Critic: a chapter contract breaks the phrase seed's chain (${ctx.template})`
                        : `Critic: the draft drifts from the Seed (${ctx.template})`,
                    // D-30: the Editor needs the what-and-where line, not just the proof. In the group
                    // model the artifact named is the Overview itself, because there is no draft row; in the
                    // chapter model it is the chapter set, for the same reason (T-W2).
                    detail: chapterPass
                        ? `Chapter 2's contract takes the setup the seed plants and never pays it — see its payoffs field against the phrase seed.`
                        : `The draft's promise leaves the Seed's central obligation unpaid — see the promise field of ${revisionId === '' ? 'the installed group Overview' : revisionId}.`,
                    evidence: chapterPass
                        ? `the Critic pass read the chapter contracts at the vector this seat was claimed for and found the seed's central setup unpaid in chapter 2`
                        : `the Critic pass read ${revisionId === '' ? target : revisionId} against the Seed and found the promise unpaid`,
                    cost,
                    // D-33 makes a phase-① Summary finding cite the draft it describes; the group model
                    // has no draft row, so the citation is simply absent and R3's `group_refs` below are
                    // what make the defect addressable instead.
                    ...(revisionId === '' ? {} : { related_refs: [revisionId] }),
                    ...(groupRefs === undefined || groupRefs.length === 0 ? {} : { group_refs: groupRefs }),
                    why: 'The Critic angle: what a reader of this Author would object to (D-30).'
                }
            });
        }

        return { toolCalls: specs };
    }

    if (ctx.template === 'critic-explorer') {
        return {
            toolCalls: [{ name: 'searchWeb', args: { query: 'lighthouse keepers who chose their own successor' } }]
        };
    }

    const specs: CrewCall[] = [];

    for (let index = 0; index < ideas; index += 1) {
        specs.push({
            name: 'proposeIdea',
            args: {
                phase: ctx.phase,
                body: `Probe Idea ${index + 1}: the ${index + 1}${index === 0 ? 'st' : 'th'} crossing should cost the keeper her sister, not a name.`,
                // §4.17's kinds; a probe round is a critic angle, so `possibility` (D-26).
                kind: 'possibility',
                // T-10: a citation is {url_or_title, claim}, never a bare string.
                sources: [
                    {
                        url_or_title: 'the Seed line about the ledger',
                        claim: 'the sea collects one memory per safe crossing'
                    }
                ],
                why: 'The critic angle: what would make this land harder.'
            }
        });
    }

    return { toolCalls: specs };
};

/**
 * §8.6's assistant: reads the collections it was given and answers in plain text (A-1). It writes
 * nothing, so the run's whole output is its final line.
 */
const assistantScript: CrewScript = (ctx) => {
    if (ctx.results.length === 0) {
        return {
            toolCalls: [
                { name: 'readSummary', args: { story_id: ctx.story?.id } },
                { name: 'readDigest', args: { story_id: ctx.story?.id } },
                { name: 'readGoals', args: { story_id: ctx.story?.id } },
                { name: 'listTasks', args: {} }
            ]
        };
    }

    return {
        content:
            ctx.options.assistantNote ??
            `The Story has ${ctx.store.chapters.list().length} chapters and the loop says ${ctx.story?.status ?? 'working'}.`
    };
};

/** One template's default script; `options.scripts` overrides any of them. */
export const CREW_SCRIPTS: Record<string, CrewScript> = {
    'writer-plotlines': writerScript,
    'writer-chapters': writerScript,
    'editor-seed-structure': editorScript,
    'editor-general': editorScript,
    'researcher-story': researcherScript,
    'reader-consistency': readerScript,
    'reader-prose': readerScript,
    // The four built-in Critics of §8.1 (`templates.ts`), all of which answer a probe round.
    'critic-genre': criticScript,
    'critic-plausibility': criticScript,
    'critic-audience': criticScript,
    'critic-mystery': criticScript,
    assistant: assistantScript
};

// ---------------------------------------------------------------------------
// The double
// ---------------------------------------------------------------------------

/**
 * The crew double. Identity comes from the BRIEF, because that is the only identity a model gets:
 * `llm/client.ts:ChatRequest` carries no run id, and `run/brief.ts` names the crew in its first
 * heading (`ROLE — <role> (<kind>) of <template>`). The turn index is the length of the conversation,
 * which is exactly what a stateless harness sees (S-1, P2).
 *
 * THE BOOK IS A THUNK IN THE WORKSPACE SHAPE: a Story's rows live in `<root>/stories/<uuid>/`, and that
 * book does not exist until the first Story is created. A `Store` captured at boot would therefore be the
 * app-config book, whose Story list is empty forever, and every crew would answer a brief about rows it
 * cannot see. The thunk is handed the BRIEF text and picks the book the brief is about: the §5 brief quotes
 * the Story's Seed verbatim (`run/brief.ts`'s `SEED —` block), so the book whose Story carries that Seed is
 * the book whose ids, revisions and criteria the answer has to cite. With one Story it is that Story either
 * way; with several, a shared double that read the first book would cite another Story's revisions and the
 * optimistic-concurrency fence (T-4) would refuse writes that were correct.
 */
export function createCrewClient(
    store: Store | ((brief: string) => Store | undefined),
    options: CrewOptions = {}
): { client: MockChatClient; refusals: CrewRefusal[] } {
    const refusals: CrewRefusal[] = [];
    const scripts = { ...CREW_SCRIPTS, ...(options.scripts ?? {}) };
    const bookOf = (text: string): Store | undefined => (typeof store === 'function' ? store(text) : store);

    const handler: MockHandler = (request): ChatResponse => {
        const brief = String(request.messages[0]?.content ?? '');

        // §2 decision 3 / §6.4 steps 3-4: a `toolMode: 'none'` run asks for a schema-constrained
        // answer, not for tool calls. It carries no ROLE brief at all — its whole memory is the
        // compiled prompt (§5) — so it is answered BEFORE the brief machinery below and never joins
        // a script's turn count: the one schema-repair retry must receive a real answer again. The
        // compiled prompt still quotes the Seed, so the same book lookup works on it.
        const storeOfRequest = bookOf(brief);

        if (request.responseFormat !== undefined)
            return {
                message: msg({
                    content: storeOfRequest === undefined ? '' : structuredAnswer(request, storeOfRequest, options)
                })
            };

        // A request with no brief in front of it is not a crew turn; answer empty and let the
        // executor's normal path close the session. Same answer for a workspace with no book yet: there
        // is no Story to brief a crew about, so there is nothing to read.
        if (!brief.includes('ROLE — ') || storeOfRequest === undefined) return { message: msg({ content: '' }) };

        const parsed = readBrief(brief, storeOfRequest, options);
        const template = parsed.template;

        // A template the suite has no script for still gets answered by its KIND — a crew is a kind
        // with a brief, and §8.1's built-ins can be renamed or added to without breaking a suite.
        const byKind: Record<string, CrewScript> = {
            writer: writerScript,
            editor: editorScript,
            researcher: researcherScript,
            reader: readerScript,
            critic: criticScript,
            assistant: assistantScript
        };
        const script = scripts[template] ?? byKind[parsed.kind];

        if (!script) throw new Error(`No crew script for template "${template}" (kind "${parsed.kind}").`);

        const turn = request.messages.filter((message) => message.role === 'assistant').length;
        const results = toolResults(request);
        const refusalsSeen = results.filter((result) => result.ok !== true);

        // The session's own bound. The loop has no turn cap (E-0), so a crew that re-issued a call
        // it had already been refused would grow the transcript until the process died; three turns
        // is the job, one re-act to a refusal, and the report.
        if (turn >= 3)
            return {
                message: msg({
                    content: `Reporting: three turns is the session (E-0 puts no cap, so the crew stops itself).`
                })
            };

        // Record each refusal the crew was given, with the tool that produced it, so a suite can
        // assert the rule it hit rather than the prose around it.
        if (refusalsSeen.length > 0) {
            const previous = lastToolCalls(request);

            for (const refusal of refusalsSeen) {
                const name = String(refusal.tool ?? previous[0]?.name ?? '');
                const issues =
                    (refusal.issues as Array<{ field?: string; expected?: unknown; received?: unknown }> | undefined) ??
                    [];

                refusals.push({
                    template,
                    tool: name,
                    rule: String(refusal.refused ?? ''),
                    message: String(refusal.message ?? ''),
                    field: issues[0]?.field,
                    expected: issues[0]?.expected === undefined ? '' : String(issues[0].expected),
                    received: issues[0]?.received === undefined ? '' : String(issues[0].received)
                });
            }
        }

        const ctx: CrewContext = {
            request,
            template,
            kind: parsed.kind,
            turn,
            store: storeOfRequest,
            story: parsed.story,
            summary: parsed.summary,
            summaryId: parsed.summaryId,
            results,
            refusals: refusalsSeen,
            criteria: parsed.criteria,
            phase: parsed.phase,
            unitTarget: parsed.unitTarget,
            draftIds: parsed.draftIds,
            reviewPass: parsed.reviewPass,
            chapterPass: parsed.chapterPass,
            directiveRef: parsed.directiveRef,
            directiveTargets: parsed.directiveTargets,
            options
        };

        const answer = script(ctx);

        if (!answer.toolCalls?.length)
            return { message: msg({ content: answer.content ?? `Reported (${template}).` }) };

        return {
            message: msg({
                toolCalls: calls(answer.toolCalls.map((call) => ({ name: call.name, args: call.args ?? {} })))
            })
        };
    };

    return { client: new MockChatClient(handler), refusals };
}

/**
 * The single structured answer of a `toolMode: 'none'` run (§4.3, §6.4 steps 3-4).
 *
 * The request carries the schema NAME in `responseFormat`, which is what tells the rig which job
 * it is answering without reading a brief that does not exist in this mode:
 *
 *   * `SummarySample` → the six prose blocks, every one derived from the compiled prompt: the
 *     `premise` echoes the Seed Brief's `logline`, and `knowledge_used` names every fingerprint the
 *     prompt's KNOWLEDGE section carried (so a test can prove the sampler saw the research).
 *   * `IssueList` → `{issues: []}` unless the test's override scripts a defect for a sample.
 *
 * A caller-scripted STRING is returned verbatim: `'not json'` is how the schema-repair retry and
 * the sampling-exhaustion escalation are driven (`src/server/run/executor.ts:STRUCTURED_ATTEMPTS`).
 * The sample index is the provider `seed` the Work Item set (§6.4 step 3); a screen has no seed,
 * so its sample index is parsed back out of the target draft's `premise` line (`sample N: …`).
 */
function structuredAnswer(request: ChatRequest, store: Store, options: CrewOptions): string {
    const system = String(request.messages.find((message) => message.role === 'system')?.content ?? '');
    const user = String(request.messages.find((message) => message.role === 'user')?.content ?? '');
    const prompt = `${system}\n\n${user}`;
    const name = request.responseFormat?.name;

    if (name === SUMMARY_SAMPLE_SCHEMA_NAME) {
        const sampleIndex = typeof request.seed === 'number' && request.seed > 0 ? request.seed : 1;
        const turn: SampleTurn = { sampleIndex, system, user, prompt };
        const answer =
            options.sampleAnswer !== undefined
                ? options.sampleAnswer(turn)
                : defaultSampleAnswer(sampleIndex, loglineOf(prompt), knowledgeFingerprintsOf(prompt));

        return typeof answer === 'string' ? answer : JSON.stringify(answer);
    }

    if (name === ISSUE_LIST_SCHEMA_NAME) {
        const draft = prompt.split('## TARGET DRAFT\n')[1] ?? '';
        const fields = draftFieldsOf(draft);
        const sampleIndex = Number(/^sample (\d+):/.exec(fields.premise ?? '')?.[1] ?? '0');
        const fixIds = fixTaskIdsOf(prompt);
        const turn: ScreenTurn = {
            sampleIndex,
            revisionId: revisionIdOf(store, fields),
            draft,
            fixIds,
            system,
            user,
            prompt
        };
        const answer = options.screenAnswer !== undefined ? options.screenAnswer(turn) : { issues: [] };

        // H1/R2 — a pass whose prompt named FIX TASKS owes a certificate for every id it was handed.
        // A scripted answer that spells its own `fix_verifications` wins; otherwise `screenFixes`
        // decides, and the default certifies the lot. Without that default every existing test that
        // scripts a `screenAnswer` would silently lose its certificate and stall the round, and a
        // round-1 screen (no FIX TASKS) keeps answering the bare `{"issues":[…]}` it always did.
        const certificate = options.screenFixes?.(turn) ?? defaultFixVerifications(fixIds, fields.premise);
        const certified =
            typeof answer === 'string' || answer.fix_verifications !== undefined || certificate.length === 0
                ? answer
                : { ...answer, fix_verifications: certificate };

        return typeof certified === 'string' ? certified : JSON.stringify(certified);
    }

    // SUMMARY PHRASE R2 — a `draft_groups` job. The groups are PARSED from the compiled prompt (see
    // `groupEntriesOf`), so the answer is built from the batch the ENGINE asked for rather than from a
    // fixture's guess: an answer for a group outside the batch, or one that leaves a named group out, is
    // refused atomically, and that refusal is a behaviour a slice can drive from here.
    if (name === GROUP_DRAFT_SCHEMA_NAME) {
        const turn: GroupDraftTurn = { groups: groupEntriesOf(prompt), system, user, prompt };
        const answer =
            options.groupDraft !== undefined
                ? options.groupDraft(turn)
                : defaultGroupDraftAnswer(turn.groups, loglineOf(prompt), knowledgeFingerprintsOf(prompt));

        return typeof answer === 'string' ? answer : JSON.stringify(answer);
    }

    // PHRASE ② T-W2 — a chapter `draft_groups` job. The groups are parsed from the SAME headings (the
    // chapter lane renders entries through the same renderer), and the answer is a `ChapterDraft`:
    // plotpoints per entry, not prose. Parsing rather than scripting is the point again — a batch of
    // three chapters and a batch of seven get answers of exactly the arity the engine asked for, which is
    // the check `parseChapterDraftAnswer` runs against the phrase's rows (seam S12).
    if (name === CHAPTER_DRAFT_SCHEMA_NAME) {
        const turn: ChapterDraftTurn = { groups: groupEntriesOf(prompt), system, user, prompt };
        const answer =
            options.chapterDraft !== undefined
                ? options.chapterDraft(turn)
                : defaultChapterDraftAnswer(turn.groups, phraseSeedLineOf(prompt), knowledgeFingerprintsOf(prompt));

        return typeof answer === 'string' ? answer : JSON.stringify(answer);
    }

    // SUMMARY PHRASE R3 — a `review_groups` job. Same certificate rule as the legacy screen (H1/R2): the
    // pass answers for every fix id its prompt named, and the default quotes the Overview it was shown.
    if (name === GROUP_REVIEW_SCHEMA_NAME) {
        const groups = groupEntriesOf(prompt);
        const fixIds = fixTaskIdsOf(prompt);
        const turn: GroupReviewTurn = { groups, fixIds, system, user, prompt };
        const answer = options.groupReview !== undefined ? options.groupReview(turn) : { issues: [] };
        const certificate = options.groupFixes?.(turn) ?? defaultFixVerifications(fixIds, groups[0]?.currentText);
        const certified =
            typeof answer === 'string' || answer.fix_verifications !== undefined || certificate.length === 0
                ? answer
                : { ...answer, fix_verifications: certificate };

        return typeof certified === 'string' ? certified : JSON.stringify(certified);
    }

    // READER SCORING D-65 — a `score_sections` job. The sections are PARSED from the compiled prompt's
    // own headings (`groupEntriesOf`), so the default answer names exactly the ids the engine printed and
    // quotes exactly the text it carried; a slice that wants a refused run scripts its own
    // `sectionScores` (an incomplete answer, a score out of range) and watches the settle write nothing.
    if (name === SECTION_SCORES_SCHEMA_NAME) {
        const turn: SectionScoreTurn = { groups: groupEntriesOf(prompt), system, user, prompt };
        const answer =
            options.sectionScores !== undefined ? options.sectionScores(turn) : defaultSectionScoreAnswer(turn.groups);

        return typeof answer === 'string' ? answer : JSON.stringify(answer);
    }

    // An unknown schema is answered with `{}` on purpose: it fails validation the same way a real
    // mis-dispatch would, rather than being papered over with a clean answer.
    return '{}';
}

/** The Seed Brief's one-sentence premise, which is the logline line of the compiled `## SEED BRIEF`. */
const loglineOf = (prompt: string): string => /^logline: (.*)$/m.exec(prompt)?.[1]?.trim() ?? 'the Seed Brief';

/** The fingerprints the prompt's KNOWLEDGE section renders, in the order the compiler sorted them. */
const knowledgeFingerprintsOf = (prompt: string): string[] => [
    ...prompt.matchAll(/\[(k_[0-9a-f]+) · (?:critical|high) · /g)
].map((match) => match[1]);

/**
 * The default sampler answer (§4.3's SummarySample). `sample <i>: <logline>` is the guarantee a
 * test leans on: the installed Summary provably came from the round's compiled prompt.
 */
export const defaultSampleAnswer = (
    sampleIndex: number,
    logline: string,
    knowledgeUsed: string[] = []
): SummarySample => ({
    premise: `sample ${sampleIndex}: ${logline}`,
    promise: `sample ${sampleIndex} pays the promise the Seed makes`,
    theme: `sample ${sampleIndex} theme`,
    tone: `sample ${sampleIndex} tone`,
    ending: `sample ${sampleIndex} ending`,
    world_rules: `sample ${sampleIndex} world rules`,
    knowledge_used: knowledgeUsed
});

/**
 * H1/R2 — the fix task ids this screening pass's prompt named, in prompt order. `renderFixTaskBlock`
 * renders one line per task as `[task_7 · priority 20 · finding_3] …` (`run/phase1-prompt.ts`), and
 * the id inside the brackets is the key the certificate answers with. A round-1 screen has no FIX
 * TASKS section, so this is `[]` and the pass certifies nothing.
 */
function fixTaskIdsOf(prompt: string): string[] {
    const section = /## FIX TASKS[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(prompt)?.[1] ?? '';

    return [...section.matchAll(/^\[([^\s·]+) · priority /gm)].map((match) => match[1]);
}

/**
 * The certificate the mock crew returns by default: every task the prompt named, `resolved`, with the
 * target draft's own premise line as the quotation. The mock is a cooperative model — a test that
 * wants a rejected repair says so through `MockCrewOptions.screenFixes` or by spelling
 * `fix_verifications` in its own `screenAnswer`.
 */
export const defaultFixVerifications = (
    fixIds: readonly string[],
    quote?: string
): SampledFixVerification[] =>
    fixIds.map((fix_ref) => ({
        fix_ref,
        status: 'resolved',
        evidence: quote === undefined || quote.trim() === '' ? `${fix_ref} is answered by the target draft` : quote.trim()
    }));

/** The `key: value` lines of a screen's `## TARGET DRAFT` block (the six Summary prose fields). */
function draftFieldsOf(draft: string): Record<string, string> {
    const fields: Record<string, string> = {};

    for (const match of draft.matchAll(/^(premise|promise|theme|tone|ending|world_rules): (.*)$/gm))
        fields[match[1]] = match[2].trim();

    return fields;
}

/**
 * Which stored revision a screen judges. The prompt deliberately carries the draft's FIELDS and
 * never its id (§5's reproducibility rule), so the resolution is by equality: the summary revision
 * whose `body.fields` reads exactly the target draft. Ties cannot arise in practice — the newest
 * match is the draft the sweep just persisted — and the newest is taken if they ever do.
 */
function revisionIdOf(store: Store, fields: Record<string, string>): string {
    const keys = ['premise', 'promise', 'theme', 'tone', 'ending', 'world_rules'];

    if (!keys.every((key) => typeof fields[key] === 'string' && fields[key].length > 0)) return '';

    const matches = store.revisions
        .list()
        .filter((revision) => {
            if (revision.unit_kind !== 'summary') return false;

            const body = revision.body as { fields?: Record<string, unknown> } | undefined;
            const stored = body?.fields;

            return stored !== undefined && keys.every((key) => stored[key] === fields[key]);
        })
        .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));

    return matches[0]?.id ?? '';
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/** A live server plus the seams the slice drives: sweeps for the clock, the store for the ledger. */
export interface StorylineFixture {
    handle: StorylineServerHandle;
    /**
     * The book the slice's Story lives in — `<root>/stories/<uuid>/`, an ACCESSOR rather than a captured
     * Store, because in the workspace shape that book exists only once a Story has been created (which is
     * the slice's first request). Before then it answers the app-config book, whose Story list is empty —
     * the same "nothing has happened yet" a fresh flat store used to read as.
     *
     * With two Stories open it is the FIRST book; a test that means a particular Story asks for its own
     * context below, and a test that means the workspace reads the routes (`fixture.api`), which merge.
     */
    readonly store: Store;
    /**
     * The workspace root: `<root>/server/` for configuration and `<root>/stories/<uuid>/` for one book per
     * Story. This is NOT a store directory any more: reload a Story's book with
     * `Store.loadStory(id, fixture.storyDir(id))`, not `Store.load(fixture.root)`.
     */
    root: string;
    /** The app-config book (`<root>/server/`): the crew catalogue and the host settings (`runtime/server-config.ts`). */
    readonly appConfig: ServerConfig;
    /** Every Story this workspace holds, one book each, as `{ id, dir }` in book order. */
    stories(): { id: string; dir: string | null }[];
    /** One Story's whole runtime — its loop, executor, tool catalogue, knowledge projection and thread log. */
    context(storyId: string): StoryRuntimeContext | undefined;
    /** The directory of one Story's book, or `null` when the book is in memory. */
    storyDir(storyId: string): string | null;
    origin: string;
    /** Every tool refusal the crews were given, in call order. */
    refusals: CrewRefusal[];
    /** Every provider request the server made, in call order (structured prompts included). */
    requests: readonly ChatRequest[];
    /** One Author action: a sweep, then every opened run to completion. */
    tick(): Promise<void>;
    /**
     * THE BARRIER a snapshot is taken behind: waits for the runs this process started — and the run
     * bookkeeping chained behind them — to close, and refuses to return while the book still shows a live
     * run row. A step that reads a Story row, a level string or an Ideas tray right after this point
     * reads ONE coherent boundary; the same read taken while a crew holds the desk is a read of an
     * arbitrary point of a write.
     */
    quiesce(): Promise<void>;
    /** Sweeps until `stop` holds; throws with the crew panel if the loop keeps running. */
    settle(stop: () => boolean | Promise<boolean>, max?: number): Promise<void>;
    api<T = unknown>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }>;
    close(): Promise<void>;
}

/** Options that shape the crew's behaviour; anything else goes to the server as a runtime option. */
export type BootOptions = CrewOptions & {
    runtime?: Partial<StorylineRuntimeOptions>;
    env?: Partial<Record<keyof typeof TEST_PROVIDER_ENV, string>>;
};

export async function bootStoryline(options: BootOptions = {}): Promise<StorylineFixture> {
    // A real root, because the restart test reloads this exact directory — as a WORKSPACE now: the app book
    // under `<root>/server/`, and one Story book per uuid under `<root>/stories/`. An empty directory is the
    // first-boot case the registry accepts; a root that still carries a flat `store.json` would be refused.
    const root = mkdtempSync(path.join(tmpdir(), 'create-storyline-integration-'));

    // The crew double reads the Story's book, which does not exist until the first Story is created, so it
    // gets a thunk over the coordinator rather than a Store captured before the server was built. The thunk
    // picks the book by the Seed the brief quotes, so a Story whose state has diverged from its sibling's is
    // answered from its OWN rows — ids, revisions and criteria and all.
    let runtimes: StoryRuntimes | undefined;

    const bookFor = (text: string): Store | undefined => {
        const contexts = runtimes?.contexts_() ?? [];
        const owner = contexts.find((context) =>
            context.store.stories.list().some((story) => story.idea.length > 0 && text.includes(story.idea))
        );

        return (owner ?? contexts[0])?.store;
    };

    const { client, refusals } = createCrewClient(bookFor, options);

    // THE CLOCK — the loop's own timer must never be a test's clock: every sweep is an explicit action.
    //
    // `autoSweep: false` IS the whole contract now. Under the coordinator a Story's `LoopEngine` never
    // schedules at all (`runtime/story-runtimes.ts:build` forces `autoSweep: false` per context, and
    // `loop/engine.ts:241` is the only place that flag is read); the ONE workspace timer is
    // `StoryRuntimes.start()`'s, and `start()` gates it on the same flag
    // (`runtime/story-runtimes.ts:autoSweeps`). `startStorylineServer` calls `engine.start()`
    // (`api/server.ts:599`), so with the flag false there is no interval anywhere: no background sweep can
    // land between two `await`s of a slice step and turn a "one sweep = one step" contract — a dispatch
    // ledger, the level strings one lock produces, the state of the Ideas tray before its verify job — into a
    // race against the scheduler. This used to need a second knob: the flag was read only per context, so the
    // coordinator scheduled unconditionally and `sweepIntervalMs: 86_400_000` (one day, past even a starved
    // run) was the only way to silence the clock. That workaround is gone; the flag means what this fixture
    // has always claimed. The per-Story scheduling gates stay OPEN, which is what `quiesce`'s note relies on.
    const engineConfig = {
        autoSweep: false,
        ...(options.runtime?.engineConfig ?? {})
    };

    const handle = await startStorylineServer({
        port: 0,
        host: '127.0.0.1',
        storeRoot: root,
        harnessRoot: root,
        chat: client,
        env: { ...TEST_PROVIDER_ENV, ...(options.env as Record<string, string | undefined>) },
        // `options.runtime` may name its own engine knobs (`slice-chapters.test.ts:44` sets the S-5
        // ceiling), and the merged config above has to be the LAST word: had the caller's `engineConfig`
        // replaced it wholesale, a caller that named only `autoSweep`/`globalMaxConcurrent` would quietly
        // put the 500ms scheduler back inside the test.
        ...(options.runtime ?? {}),
        engineConfig,
        // The dashboard bundle is not built in a test checkout, so the static root stays null.
        staticRoot: null
    });

    runtimes = handle.runtimes;

    const base = `http://127.0.0.1:${handle.port}/v1/storyline`;

    /** The book the slice asserts on: its Story's, or the app book while no Story exists. */
    const storyStore = (): Store => handle.runtimes.contexts_()[0]?.store ?? handle.store;

    async function api<T = unknown>(
        method: string,
        route: string,
        body?: unknown
    ): Promise<{ status: number; body: T }> {
        const response = await fetch(`${base}${route}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });

        const text = await response.text();

        return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
    }

    async function tick(): Promise<void> {
        await handle.engine.sweep();

        // `settle()` drains the engine's in-flight map, and a tool call can open another run inside
        // the same pass, so a sweep is not one call — it is however many passes the runs take. The live
        // count is the workspace's, because the one ceiling is enforced across every book at once (S-5).
        for (let index = 0; index < 12; index += 1) {
            await handle.engine.settle();
            if (handle.runtimes.liveRuns() === 0) break;
        }
    }

    /**
     * The quiescence barrier (see `StorylineFixture.quiesce`). Two things have to be empty before a
     * snapshot is worth pinning, and they are not the same thing:
     *
     *   * `engine.settle()` — the runs THIS process started, including the `settleJob` bookkeeping chained
     *     into the same promise (`loop/engine.ts:1052`), so a closed run row can still have a settlement
     *     commit in flight behind it;
     *   * `runtimes.liveRuns()` — the books' own answer for "a crew still holds the desk" (a run row in
     *     `spawning|working|reporting`), which is what the panel's `active_runs` counts and what the next
     *     sweep would read as a claim (L-5).
     *
     * With the workspace timer switched OFF (`autoSweep: false`, which is what `bootStoryline`'s clock note
     * pins and what `StoryRuntimes.start()` now honours) nothing moves between
     * this returning and the caller's read, which is what turns "the row we hope the lock produced" into
     * "the row the lock produced". The loop is left running on purpose: `runtimes.stop()` would also flip
     * each Story's scheduling gate and make the NEXT explicit sweep skip the book
     * (`story-runtimes.ts:837`), so the fixture stays the clock rather than the Author's pause button.
     */
    async function quiesce(): Promise<void> {
        // Two drains. `settle()` already loops until its in-flight map is empty, so a second pass only
        // catches a settlement that itself opened a run — cheap insurance before a snapshot.
        for (let pass = 0; pass < 2; pass += 1) {
            await handle.engine.settle();

            // A run row that outlives every in-flight promise has an owner this process never started (a
            // lease a previous process left, adopted by the sweep). Past that the barrier reports rather
            // than pinning a snapshot taken mid-write. It never SWEEPS: a sweep would dispatch new work,
            // which is the opposite of the boundary a caller is about to snapshot.
            if (handle.runtimes.liveRuns() === 0) return;
        }

        const live = handle.runtimes.contexts_().flatMap((context) => liveRunRows(context.store));

        throw new Error(`The workspace never went quiet — the book still carries live runs:\n${live.join('\n')}`);
    }

    async function settle(stop: () => boolean | Promise<boolean>, max = 24): Promise<void> {
        for (let round = 0; round < max; round += 1) {
            await tick();
            if (await stop()) return;
        }

        const runs = await api<Array<Record<string, unknown>>>('GET', '/runs');

        throw new Error(
            `The loop never reached the state the test asked for, in ${max} sweeps:\n${runs.body
                .map((run) => `${run.id} ${run.template_ref} ${run.role} ${run.state} ${run.work_item_ref}`)
                .join('\n')}`
        );
    }

    return {
        handle,
        get store() {
            return storyStore();
        },
        get appConfig() {
            return handle.runtimes.appConfig;
        },
        root,
        origin: base,
        stories: () => handle.runtimes.contexts_().map((context) => ({ id: context.storyId, dir: context.root })),
        context: (storyId: string) => handle.runtimes.contextOf(storyId),
        storyDir: (storyId: string) => handle.runtimes.contextOf(storyId)?.root ?? null,
        refusals,
        // The mock client records every request it received; exposing them keeps a suite from
        // threading its own recorder through the crew options.
        requests: client.calls,
        tick,
        quiesce,
        settle,
        api,
        close: async () => {
            // `handle.close()` IS the whole shutdown now: the coordinator settles every Story's runs, disposes
            // every harness, closes every knowledge projection and flushes every book plus the app book.
            await handle.close();
            rmSync(root, { recursive: true, force: true });
        }
    };
}

// ---------------------------------------------------------------------------
// Projections the slice asserts on
// ---------------------------------------------------------------------------

/** The §15 seed: long enough that the shipped minimum-length rule on `POST /stories` passes. */
export const SLICE_SEED =
    'A nobody inherits a lighthouse that chooses its own keeper, and the lamp has been waiting for her.';

/** Creates the slice's Story through the real route and returns its id. */
export async function createSliceStory(
    fixture: StorylineFixture,
    chapterCount = 3,
    /**
     * Phase ①'s counts for the walk. The tests use a small sample/critic set so a deterministic
     * scripted crew can finish the pipeline inside a bounded number of sweeps; the product's
     * standard (five Writers, five Critics per draft) is the default the route applies when these
     * are omitted, and is pinned separately.
     */
    review: { sampling?: number; critics?: number; mode?: 'groups' | 'sampling' } = {}
): Promise<string> {
    const { status, body } = await fixture.api<{ id: string }>('POST', '/stories', {
        idea: SLICE_SEED,
        chapter_count: chapterCount,
        summary_sampling: review.sampling ?? 3,
        summary_critics: review.critics ?? 1,
        // SUMMARY PHRASE R6: the slices walk the pipeline the scripted crews are written for — the
        // whole-Summary sampler (N drafts, screening, one selection). The route's default is now the
        // group pipeline, so the harness names the legacy mode EXPLICITLY rather than inheriting it;
        // `{ mode: 'groups' }` is how a Summary Phrase slice asks for the five-group loop instead.
        summary_mode: review.mode ?? 'sampling'
    });

    if (status !== 200) throw new Error(`POST /stories failed: ${status} ${JSON.stringify(body)}`);

    return body.id;
}

/**
 * The dial: the whole approval ladder auto-approved, so a finding goes open → confirmed → approved
 * → task inside one sweep (L-24's standing Authorisation, §15 step 3's precondition).
 *
 * There is no `divergence_mode` field to set: divergence is a property of the ASSIGNED templates
 * (`tools/artifacts.ts:isDivergenceMode` reads `stories.template_refs`), and the built-in writers
 * all carry `attempts > 1`, so the slice's Story diverges from the moment it exists.
 */
export async function openDial(
    fixture: StorylineFixture,
    storyId: string,
    costs: Cost[] = ['critical', 'major', 'minor', 'taste']
): Promise<void> {
    const { status, body } = await fixture.api('PATCH', `/stories/${storyId}`, { auto_approve: costs });

    if (status !== 200) throw new Error(`PATCH /stories/:id (dial) failed: ${status} ${JSON.stringify(body)}`);
}

/** Walks the phases until `stop` holds, locking each phase the loop leaves open (§15's Author verbs). */
export async function advanceUntil(
    fixture: StorylineFixture,
    stop: () => boolean | Promise<boolean>,
    max = 40
): Promise<void> {
    for (let round = 0; round < max; round += 1) {
        if (await stop()) return;
        await fixture.tick();
        if (await stop()) return;

        const row = await storyRow(fixture, fixture.store.stories.list()[0].id);

        // A signoff the loop is waiting on is the Author's move, so the walk makes it (D-1). A sign-off
        // the lock REFUSES is the other one: `drained` means the desk is full, and the Author's answer
        // there is to clear it (`POST /clear-pending`) so the ladder gets its turn (L-24).
        if (row.status === 'pending') {
            const lock = await fixture.api('POST', `/stories/${row.id}/lock`);

            if (lock.status !== 200) await fixture.api('POST', `/stories/${row.id}/clear-pending`);
        }
    }

    throw new Error(
        `advanceUntil never reached the state the test asked for in ${max} rounds. Last reported: ${JSON.stringify(await storyRow(fixture, fixture.store.stories.list()[0].id))}`
    );
}

/** The Story row as `GET /stories` sends it, including `levels`, `trend` and `state`. */
export async function storyRow(fixture: StorylineFixture, storyId: string): Promise<Record<string, any>> {
    const { body } = await fixture.api<Array<Record<string, any>>>('GET', '/stories');
    const row = body.find((candidate) => candidate.id === storyId);

    if (!row) throw new Error(`storyRow: ${storyId} is not in the panel.`);

    return row;
}

/**
 * The SAME row, rendered out of a Store the caller names instead of over HTTP.
 *
 * This is the shipped projection, not a fixture invention: `GET /stories` builds every row with
 * `api/projections.ts:storyRow(deps, story)` over the Story's own book, and a workspace's merged panel is
 * just those rows concatenated (`projections.ts:storyRowsAcross`). So the row this returns IS the row a
 * restarted server answers from the book it re-opened — which is what §15's L-26 claims, and what the HTTP
 * `storyRow` above cannot answer about a SECOND Store (its `fixture.api` always reaches the live server).
 *
 * WHY FRESH ENGINES ARE CORRECT: `criteria` and `digest` hold no state and read nothing but the rows they
 * are handed — `CriteriaEngine` has no constructor and keeps only call-local maps
 * (`criteria/engine.ts:941` `levelStatus(store, story)`), and `runtime/story-runtimes.ts:207` says of them
 * "pure over the rows they are handed (L-3): one each". The route hands the same pair to every book
 * (`api/routes.ts:365` `projections(book)` swaps only the store), so a new pair over a journal-loaded book
 * answers exactly what the live pair answered over the live one.
 */
export function storyRowFrom(store: Store, storyId: string): Record<string, any> {
    const story = store.stories.get(storyId);

    if (story === undefined) throw new Error(`storyRowFrom: ${storyId} is not in this book.`);

    return projectStoryRow({ store, criteria: new CriteriaEngine(), digest: new DigestBuilder() }, story);
}

/** The Story's whole view as `GET /stories/:id` sends it. */
export async function storyView(fixture: StorylineFixture, storyId: string): Promise<Record<string, any>> {
    return (await fixture.api<Record<string, any>>('GET', `/stories/${storyId}`)).body;
}

/** The crew panel as `GET /runs?story_id=` sends it. */
export async function crewRows(fixture: StorylineFixture, storyId: string): Promise<Array<Record<string, any>>> {
    return (await fixture.api<Array<Record<string, any>>>('GET', `/runs?story_id=${storyId}`)).body;
}

/** The queue as `GET /queue` sends it — a bare array, not a wrapper. */
export async function queue(fixture: StorylineFixture): Promise<Array<Record<string, any>>> {
    return (await fixture.api<Array<Record<string, any>>>('GET', '/queue')).body;
}

/** The templates that actually ran, deduped and sorted — "phase ② dispatched the Writer" (§15 step 2). */
export async function crewTemplates(fixture: StorylineFixture, storyId: string): Promise<string[]> {
    const rows = await crewRows(fixture, storyId);

    return [...new Set(rows.map((row) => String(row.template_ref)))].sort();
}

/** Every chapter state, order-sorted, so the L-8/L-35 shape is one assertable value. */
export function chapterStates(store: Store, storyId: string): Array<Pick<Chapter, 'id' | 'order' | 'state'>> {
    return store.chapters
        .list()
        .filter((chapter) => chapter.story_id === storyId)
        .sort((left, right) => left.order - right.order)
        .map((chapter) => ({ id: chapter.id, order: chapter.order, state: chapter.state }));
}

/** Who was judged: every verdict row's target and recommendation, id-sorted. */
export function verdictTargets(
    store: Store,
    storyId: string
): Array<{ id: string; target: string; recommendation: Verdict['recommendation'] }> {
    return store.verdicts
        .list()
        .filter((verdict) => verdict.story_id === storyId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((verdict) => ({ id: verdict.id, target: verdict.target_ref, recommendation: verdict.recommendation }));
}

/** The Plotline contracts, order-sorted. */
export function plotlineOrders(store: Store, storyId: string): Plotline[] {
    return store.plotlines
        .list()
        .filter((row) => row.story_id === storyId)
        .sort((left, right) => left.order - right.order);
}

/** The Ideas tray as the Author sees it: state and kind per id, creation order. */
export function ideaStates(store: Store, storyId: string): Array<Pick<Idea, 'id' | 'state' | 'kind'>> {
    return store.ideas
        .list()
        .filter((idea) => idea.story_id === storyId)
        .map((idea) => ({ id: idea.id, state: idea.state, kind: idea.kind }));
}

/** Findings as `id:state/cost`, sorted — the repair chain's ledger (§15 step 3a). */
export function findingStates(store: Store, storyId: string): string[] {
    return store.findings
        .list()
        .filter((finding) => finding.story_id === storyId)
        .map((finding) => `${finding.id}:${finding.state}/${finding.cost}`)
        .sort((left, right) => left.localeCompare(right));
}

/** Drafts as `id:unit_ref/state`, sorted — the competing-draft ledger (D-3d) and the selection (D-3b). */
export function revisionStates(store: Store, storyId: string): string[] {
    return store.revisions
        .list()
        .filter((revision: Revision) => revision.story_id === storyId)
        .map((revision: Revision) => `${revision.id}:${revision.unit_ref}/${revision.state}`)
        .sort((left, right) => left.localeCompare(right));
}

/**
 * The runs still open: a Run row exists before the first token (D-18) and closes in `finally` (S-3),
 * so `ended_at` empty is exactly "the loop is still working".
 */
export function liveRunRows(store: Store): string[] {
    return store.runs
        .list()
        .filter((run) => run.ended_at === undefined || run.ended_at === null)
        .map((run) => `${run.id}:${run.state}`);
}
