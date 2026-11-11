// §15's vertical slice, driven through the REAL server (W10).
//
// What this module is: the scripted CREW. Every suite here boots the shipped server
// (`startStorylineServer`, `port: 0`) with the shipped Store, run executor, §8 tool catalogue,
// criteria engine and Digest builder, and injects exactly one double — a `MockChatClient` whose
// answers are the crews' tool calls. That is what makes these integration tests rather than route
// tests: a loop decision is only proven when a real run, holding a real lease and a real brief,
// calls a real tool that really refuses or really writes.
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
//     send it again with the rev you were handed". The crew does exactly that, once per session —
//     the loop has no turn cap (E-0), so an uncapped re-send of a losing CAS race would spin.
//   - it never invents a rule the catalogue does not have: one verdict line per criterion the brief
//     actually briefed it on, split across the two scopes the criteria engine aggregates over
//     (`criteria/engine.ts:scopeTargets`) — the artifact for everything except C-4/C-10/C-11/C-13,
//     which are filed at the Story row.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startStorylineServer, type StorylineRuntimeOptions, type StorylineServerHandle } from '../api/server';
import { MockChatClient, type MockHandler, calls, msg } from '../llm/mock';
import type { ChatRequest, ChatResponse, ToolCall } from '../llm/client';
import { Store } from '../store/store';
import type { Chapter, Cost, Idea, Plotline, Revision, Story, Summary, Verdict } from '../../shared/types';

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
    /** The phase the brief's PHASE section names — where a Reader's Idea belongs. */
    phase: string;
    unitTarget?: string;
    /** The Story's Summary row id, which is where `chapter_count` lives (D-3b: Author truth). */
    summary?: Summary;
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
    /** Cost of a finding the Checker files on each chapter unit it judges (§15 step 3a). */
    raiseFindings?: Cost;
    /** How many Ideas each Reader run files; the shipped default of 1 matches §6.7's probe round. */
    readerIdeas?: number;
    /** Verify Ideas as `refuted` instead of `confirmed`, so the tray gets a real rejection (D-27). */
    refuteIdeas?: boolean;
    /** Extra tool calls a Checker run makes on a chapter unit before reporting (U-3's drill). */
    checkerDrill?: boolean;
    /** The assistant run's final answer line (A-1: plain text to the Author, no writes). */
    assistantNote?: string;
}

// The criteria the engine aggregates over the Story row rather than the artifact: C-4's subject is
// the whole set, and C-10/C-11/C-13 are whole-level checks (`criteria/engine.ts:scopeTargets`).
export const STORY_SCOPED_CRITERIA = ['C-4', 'C-10', 'C-11', 'C-13'];

/** The Summary's §4.2 fields — the shipped `C-1` shape requires each of them non-empty. */
export const SUMMARY_FIELDS = {
    premise: 'A nobody inherits a lighthouse that chooses its own keeper.',
    promise: 'Every keeper pays what the lamp asks, and the reader hears the price first.',
    theme: 'Belonging is a debt the living pay to the dead.',
    tone: 'tidal, plain-spoken, close third person',
    ending: 'The last keeper climbs the last gallery and the light chooses her.',
    world_rules: 'The lamp keeps its own log of every keeper, and the log outlives them.'
};

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
            tool_calls?: Array<{ name: string; arguments: string }>;
        };
        if (message.role !== 'assistant') continue;

        return message.tool_calls ?? [];
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

    const unitTarget =
        /summary_id=(\S+)/.exec(brief)?.[1] ??
        /chapter_(\d+)/.exec(brief)?.[0] ??
        /plotline_(\d+)/.exec(brief)?.[0] ??
        summary?.id ??
        story?.id;

    return {
        kind: role?.[2] ?? '',
        template: role?.[3] ?? '',
        story,
        summary,
        summaryId: summary?.id,
        unitTarget,
        criteria,
        draftIds: [...brief.matchAll(/revision_id=(revision_\d+)/g)].map((match) => match[1]),
        findingIds: [...brief.matchAll(/^- (finding_\d+) \[/gm)].map((match) => match[1]),
        ideaIds: [...brief.matchAll(/^- (idea_\d+) \[/gm)].map((match) => match[1]),
        taskIds: [...brief.matchAll(/^- (task_\d+) \[/gm)].map((match) => match[1]),
        phase: /Phase: (\w+)\./.exec(brief)?.[1] ?? story?.phase ?? 'summary'
    };
}
// ---------------------------------------------------------------------------
// The Checker's report
// ---------------------------------------------------------------------------

/**
 * One verdict line per briefed criterion, filed at the scope the engine aggregates over. `submitVerdict`
 * takes one `target_ref` (§8.3) and `criteria/engine.ts:passingFor` counts a line only when its
 * target equals the scope the criterion needs — so a double that filed everything at the artifact
 * could never complete a level, which is the bug §15 exists to catch (see also tools/checker.ts).
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

    // `recommendation` is a `z.enum` over `advance | fix | stuck` (tools/checker.ts) — never `done`.
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

    if (ctx.template === 'writer-summary') {
        // ① expands the Seed into the §4.2 fields. In a diverging Story the tool files each attempt
        // as a competing draft by itself (writer.ts:D-3d), which is what gives the Editor a select
        // job in §15 step 1 — the crew does not ask for it.
        return {
            toolCalls: [
                {
                    name: 'editSummary',
                    args: {
                        ...SUMMARY_FIELDS,
                        ...(summaryId ? { expects: [{ id: summaryId, rev: revOf(store, summaryId) ?? 0 }] } : {}),
                        why: 'The Seed expanded into the Summary fields (C-1, C-14).'
                    }
                },
                ...verdictCalls(ctx, 'Probe: every central Seed element has a Summary field.')
            ]
        };
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
    const { draftIds, findingIds, ideaIds } = readBrief(ctx.request.messages[0]?.content ?? '', ctx.store, ctx.options);

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
                .filter((revision) => revision.story_id === ctx.story?.id && revision.state === 'competing');

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
                .find((revision) => revision.story_id === ctx.story?.id && revision.state === 'competing');

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
            args: {
                finding_id: id,
                verdict: 'confirmed',
                cost: 'major',
                evidence: 'Probe: re-read the named lines.',
                why: 'D-33 verification.'
            }
        });
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

/** The Checker crew: verdict lines for the briefed criteria, plus the optional finding and drill. */
const checkerScript: CrewScript = (ctx) => {
    const unit = String(ctx.unitTarget ?? '');
    const specs: CrewCall[] = [];

    // D-35's point made visible: an unfamiliar shape is looked up with `describeTool`, not guessed.
    if (ctx.options.checkerDrill && ctx.results.length === 0)
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

/** The Research crew: probe Ideas about the Story as it runs (§6.7), Explorer research (D-25). */
const readerScript: CrewScript = (ctx) => {
    const ideas = ctx.options.readerIdeas ?? 1;

    if (ctx.results.length > 0) return { content: `Reported (${ctx.template}).` };

    if (ctx.template === 'reader-explorer') {
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
                // §4.17's kinds; a probe round is a reader angle, so `possibility` (D-26).
                kind: 'possibility',
                // T-10: a citation is {url_or_title, claim}, never a bare string.
                sources: [
                    {
                        url_or_title: 'the Seed line about the ledger',
                        claim: 'the sea collects one memory per safe crossing'
                    }
                ],
                why: 'The reader angle: what would make this land harder.'
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
    'writer-summary': writerScript,
    'writer-plotlines': writerScript,
    'writer-chapters': writerScript,
    'editor-general': editorScript,
    'checker-consistency': checkerScript,
    'checker-prose': checkerScript,
    // The four built-in Readers of §8.1 (`templates.ts`), all of which answer a probe round.
    'reader-genre': readerScript,
    'reader-plausibility': readerScript,
    'reader-audience': readerScript,
    'reader-mystery': readerScript,
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
 */
export function createCrewClient(
    store: Store,
    options: CrewOptions = {}
): { client: MockChatClient; refusals: CrewRefusal[] } {
    const refusals: CrewRefusal[] = [];
    const scripts = { ...CREW_SCRIPTS, ...(options.scripts ?? {}) };

    const handler: MockHandler = (request): ChatResponse => {
        const brief = String(request.messages[0]?.content ?? '');

        // A request with no brief in front of it is not a crew turn; answer empty and let the
        // executor's normal path close the session.
        if (!brief.includes('ROLE — ')) return { message: msg({ content: '' }) };

        const parsed = readBrief(brief, store, options);
        const template = parsed.template;

        // A template the suite has no script for still gets answered by its KIND — a crew is a kind
        // with a brief, and §8.1's built-ins can be renamed or added to without breaking a suite.
        const byKind: Record<string, CrewScript> = {
            writer: writerScript,
            editor: editorScript,
            checker: checkerScript,
            reader: readerScript,
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
            store,
            story: parsed.story,
            summary: parsed.summary,
            summaryId: parsed.summaryId,
            results,
            refusals: refusalsSeen,
            criteria: parsed.criteria,
            phase: parsed.phase,
            unitTarget: parsed.unitTarget,
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

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/** A live server plus the seams the slice drives: sweeps for the clock, the store for the ledger. */
export interface StorylineFixture {
    handle: StorylineServerHandle;
    store: Store;
    root: string;
    origin: string;
    /** Every tool refusal the crews were given, in call order. */
    refusals: CrewRefusal[];
    /** One Author action: a sweep, then every opened run to completion. */
    tick(): Promise<void>;
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
    // A real root, because the restart test reloads this exact directory with `Store.load`.
    const root = mkdtempSync(path.join(tmpdir(), 'create-storyline-integration-'));
    const store = await Store.load(root);

    const { client, refusals } = createCrewClient(store, options);

    const handle = await startStorylineServer({
        port: 0,
        host: '127.0.0.1',
        store,
        chat: client,
        env: { ...TEST_PROVIDER_ENV, ...(options.env as Record<string, string | undefined>) },
        // The loop's own timer must never be a test's clock: every sweep is an explicit action.
        engineConfig: { autoSweep: false, ...(options.runtime?.engineConfig ?? {}) },
        // The dashboard bundle is not built in a test checkout, so the static root stays null.
        staticRoot: null,
        ...(options.runtime ?? {})
    });

    const base = `http://127.0.0.1:${handle.port}/v1/storyline`;

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
        // the same pass, so a sweep is not one call — it is however many passes the runs take.
        for (let index = 0; index < 12; index += 1) {
            await handle.engine.settle();
            if (liveRunRows(store).length === 0) break;
        }
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
        store,
        root,
        origin: base,
        refusals,
        tick,
        settle,
        api,
        close: async () => {
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
export async function createSliceStory(fixture: StorylineFixture, chapterCount = 3): Promise<string> {
    const { status, body } = await fixture.api<{ id: string }>('POST', '/stories', {
        idea: SLICE_SEED,
        chapter_count: chapterCount
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
