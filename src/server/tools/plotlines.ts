/**
 * PHRASE ② STRUCTURING — `structurePlotlines`, the Editor's chapter decision over Phrase ②'s seed.
 *
 * WHAT THIS MODULE IS: the tool half of Phrase ②'s step 1 (`phrase/controllers/plotlines.ts`'s
 * start → structure → accept chain). The Summary's structuring pass (`knowledge.ts:structureSeed`)
 * projects the Author's Seed into a `seed_briefs` row; this one projects the PHRASE's copied seed
 * into a `plotline_briefs` row, and its one irrevocable act is the chapter count. It belongs to NO §8
 * section — like the Phase-1 research surface, it post-dates the pinned catalogue tables — which is
 * why `registry.ts` registers it as its own group rather than folding it into `editor`.
 *
 * WHY ONE TOOL DOES BOTH THE CREATE AND THE ACCEPT (and `structureSeed` does not): the acceptance is
 * where the brief stops being a note and becomes records — `summaries.chapter_count` and the
 * `chapter_1..N` entry rows — and Phrase ②'s loop has no separate "an Author reads the brief" step to
 * hang acceptance on. `acceptPlotlineBrief` is idempotent and refuses a stale brief on its own, so
 * running the two domain calls in ONE commit is the same atomicity rule the loop holds everywhere
 * (P1): a crash leaves either a book with its chapter set or the book exactly as it was.
 *
 * D-3b is NOT bent by this: the chapter count stays a number no WRITER chooses. This call is the
 * Editor's structure pass, and the authority is the same one the classic phase ② pipeline has always
 * had — the structuring step, not the drafting step.
 */
import { PHRASE_PLOTLINES_KEY } from '../../shared/phrase';
import type { PlotlineBrief, PlotlineBriefChapter } from '../../shared/types';
import { seedHashOf } from '../../shared/seed-hash';
import {
    acceptPlotlineBrief,
    createPlotlineBrief,
    phraseSeedOf,
    storyPhraseByKey,
    type PlotlineBriefInit
} from '../phrase';
import { EXPECTS_ARG, arr, num, obj, str, whyArg } from './schema';
import { buildAttribution, commitAs, ok, repeatResult, ToolRefusal, whyOf } from './utilities';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from './types';

/** Reads one required string arg, trimmed (the schema already refused a missing one, T-11). */
function textArg(ctx: ToolExecutionContext, name: string): string {
    const raw = ctx.args[name];
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * The chapter seeds the Editor hands down, in the brief's own shape (`{order, seed}` pairs).
 *
 * Entries that are not objects, or whose `order` is not a positive whole number, are DROPPED rather
 * than refused: this list is a note that materialization never reads (`ensureChapterGroups` counts, it
 * does not enumerate), and refusing a whole structuring pass over a ragged note would cost the Author a
 * chapter set the Editor got right. The count IS load-bearing and is refused separately.
 */
function chapterSeedsArg(ctx: ToolExecutionContext): PlotlineBriefChapter[] {
    const raw = ctx.args.chapters;

    if (!Array.isArray(raw)) return [];

    const chapters: PlotlineBriefChapter[] = [];

    for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') continue;

        const record = entry as Record<string, unknown>;
        const order = Math.trunc(Number(record.order));

        if (!Number.isInteger(order) || order < 1) continue;

        const seed = typeof record.seed === 'string' ? record.seed.trim() : '';

        if (seed === '') continue;
        if (chapters.some((row) => row.order === order)) continue;

        chapters.push({ order, seed });
    }

    return chapters.sort((left, right) => left.order - right.order);
}

/**
 * The optional research questions, cleaned the way a DESCRIPTIVE list is cleaned (trim, drop blanks,
 * first-seen dedup). Unlike `structureSeed`'s `research_questions`, this one is NOT a decision gate:
 * Phrase ② has no research leg of its own (the Seed's pass already ran), so an absent list means
 * "none noted", never "waived", and it is omitted from the row rather than stored as `[]`.
 */
function notesListArg(ctx: ToolExecutionContext, name: string): string[] {
    const raw = ctx.args[name];

    if (!Array.isArray(raw)) return [];

    const seen: string[] = [];

    for (const entry of raw) {
        if (typeof entry !== 'string') continue;

        const text = entry.trim();

        if (text === '' || seen.includes(text)) continue;
        seen.push(text);
    }

    return seen;
}

// ── structurePlotlines (Phrase ② step 1 — the chapter decision) ─────────────────────────────

const structurePlotlines: ToolDefinition = {
    name: 'structurePlotlines',
    description:
        "Write the Plotline Brief for this Story's Plotlines Phrase: the Editor's chapter decision over the PHRASE's own copied seed — chapter_count plus the per-chapter seeds. It is the Phrase ② mirror of structureSeed, and the hash it checks is the hash of the phrase's seed, NOT of the Story's Seed, so a Phrase ① edit can never make this brief stale. Accepting the brief is part of this call: it sets summaries.chapter_count and materializes chapter_1..chapter_N as phrase entries IN ONE COMMIT, all N at once, and every later chapter job writes against that set. Refuses a brief derived from a seed that has moved (P5), refuses while the Plotlines contract is locked (L-7), and returns the existing brief instead of duplicating one for the same hash. The phrase's seed is never edited.",
    inputSchema: {
        type: 'object',
        properties: {
            seed_hash: str(
                'The hash of the Plotlines Phrase seed your brief quotes (it prints the phrase seed and its seed_hash). A different value means the phrase seed changed while you read it, and the chapter set would describe a book nobody is writing (P5).'
            ),
            chapter_count: num(
                'How many chapters this seed resolves into. It is a DECISION, not a guess (D-3b): it becomes summaries.chapter_count and the exact set of chapter entries every Writer pass answers for. One chapter is a valid answer.'
            ),
            chapters: arr(
                'Optional per-chapter seeds: the one-line intention each chapter carries, as {order, seed} pairs. Materialization counts chapters, it does not read this list, so it is guidance for the Writers — leave it out when the seed already says per chapter.',
                obj(
                    'One chapter seed.',
                    {
                        order: num('The chapter number, 1-based.'),
                        seed: str("The chapter's one-line intention, in the Editor's words.")
                    },
                    ['order', 'seed']
                )
            ),
            research_questions: arr(
                'Optional facts a chapter contract cannot settle from the seed alone. Phrase ② has no research leg of its own — the Seed brief settled phase ① — so these are notes for the Writers, not a gate; leave the arg out when there are none.',
                str('One open fact.')
            ),
            notes: str('What the chapter set turns on: the seam an Editor would look at first, in one line.'),
            expects: EXPECTS_ARG,
            why: whyArg('One-line reason this chapter set is the faithful reading of the phrase seed (T-5).')
        },
        required: ['seed_hash', 'chapter_count', 'why']
    },
    writes: 'plotline_briefs',
    level: 'write',
    mutating: true,
    // Like `structureSeed`: the call CREATES a brief, so `expects` is accepted for symmetry with §7.1's
    // arg table but not required (T-4 scopes to a row the caller read; this tool's guard is the hash).
    expectsArg: false,
    primaryArg: 'seed_hash',
    // The Editor owns the chapter decision; every other kind is refused at the row (T-1a).
    kinds: ['editor'],
    onlyKinds: ['editor'],
    requires: ['seed_hash', 'chapter_count', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const story = ctx.story;

        // THE PHRASE HAS TO EXIST. `starts_on_demand` (shared/phrase.ts) means Phrase ② has no row until
        // the Author hands it text, and a chapter count over no seed is a number with no book under it.
        // The refusal names who starts it, because an Editor that invents a seed is the failure mode.
        const phrase = storyPhraseByKey(ctx.store, ctx.storyId, PHRASE_PLOTLINES_KEY);

        if (phrase === undefined) {
            throw new ToolRefusal(
                'T-11',
                'structurePlotlines has no Plotlines Phrase to structure: this Story has not started Phrase ②, so there is no seed for a chapter set to be read from',
                {
                    field: 'seed_hash',
                    story_id: ctx.storyId,
                    rule: 'D-3b',
                    fix: 'the Author starts the Plotlines Phrase (with the compiled Summary or their own text) before the Editor can structure it'
                }
            );
        }

        // L-7: `plotlines_locked` is the Author's declaration that the chapter contracts are law. A new
        // chapter set under that flag would silently retire contracts the Author already signed.
        if (story.plotlines_locked) {
            throw new ToolRefusal(
                'L-7',
                'structurePlotlines refused while the Plotlines contract is locked: the Author signed the chapter set, so a new brief would replace contracts nobody unlocked',
                {
                    field: 'seed_hash',
                    story_id: ctx.storyId,
                    phrase_id: phrase.id,
                    fix: 'unlock the Plotlines contract first, then re-structure'
                }
            );
        }

        // P5, one phrase down: the hash is computed HERE from the phrase's own seed (`phraseSeedOf`), and
        // the agent's value is compared, never trusted. This is what makes the two phrases discrete — a
        // Phrase ① edit moves `stories.idea` and leaves this gate untouched.
        const currentHash = seedHashOf(phraseSeedOf(phrase, story));
        const declaredHash = textArg(ctx, 'seed_hash');

        if (declaredHash !== currentHash) {
            throw new ToolRefusal(
                'P5',
                'structurePlotlines received a seed_hash that does not match the seed this Plotlines Phrase holds now: the seed changed while you read it, so the chapter set would describe a book nobody is writing',
                {
                    field: 'seed_hash',
                    story_id: ctx.storyId,
                    phrase_id: phrase.id,
                    received: declaredHash,
                    expected: currentHash,
                    fix: 're-derive the brief from the current phrase seed: the structure job quotes it and prints its seed_hash, then send that value'
                }
            );
        }

        // The chapter count is the whole product, so it is refused BEFORE any record moves.
        // `createPlotlineBrief` re-checks it (a tool call is one caller of many); this refusal is the one
        // that can name the fix.
        const chapterCount = Math.trunc(Number(ctx.args.chapter_count));

        if (!Number.isInteger(chapterCount) || chapterCount < 1) {
            throw new ToolRefusal(
                'T-11',
                `structurePlotlines needs chapter_count as a whole number of chapters at least 1, and received ${String(ctx.args.chapter_count)}`,
                {
                    field: 'chapter_count',
                    received: ctx.args.chapter_count,
                    rule: 'D-3b',
                    fix: 'count the chapters the seed resolves into and send that number — 1 is a valid chapter set'
                }
            );
        }

        // T10/F9's ordering rule, copied from `structureSeed`: every value is validated BEFORE the
        // idempotence read, so a malformed call can never be absorbed by a `repeat` of the row that is
        // already on the record.
        const chapters = chapterSeedsArg(ctx);
        const questions = notesListArg(ctx, 'research_questions');
        const notes = textArg(ctx, 'notes');

        if (chapters.some((chapter) => chapter.order > chapterCount)) {
            throw new ToolRefusal(
                'T-11',
                `structurePlotlines was handed a chapter seed for chapter ${chapters.find((chapter) => chapter.order > chapterCount)!.order} but a chapter_count of ${chapterCount}: the set and its seeds disagree about how many chapters exist`,
                {
                    field: 'chapters',
                    rule: 'D-3b',
                    fix: 'drop the seed above the count, or raise chapter_count to include it'
                }
            );
        }

        // D-16-style idempotence, keyed on (phrase, seed hash): an accepted brief for THIS seed is the
        // answer, not a reason to write a second chapter set. A re-dispatched Editor — or a run that lost
        // its answer — converges on the same rows, which is what keeps a restart from re-deriving the
        // chapter set a Writer is already working through.
        const accepted = ctx.store.plotlineBriefs
            .list()
            .find(
                (brief) =>
                    brief.phrase_id === phrase.id && brief.seed_hash === currentHash && brief.status === 'accepted'
            );

        if (accepted !== undefined) {
            return repeatResult(
                `Plotline Brief already accepted as ${accepted.id} for phrase seed ${currentHash}`,
                {
                    plotline_brief_id: accepted.id,
                    id: accepted.id,
                    phrase_id: accepted.phrase_id,
                    seed_hash: accepted.seed_hash,
                    chapter_count: accepted.chapter_count,
                    status: accepted.status,
                    current_rev: accepted.rev
                },
                { plotline_brief_id: accepted.id }
            );
        }

        const why = whyOf(ctx);
        const init: PlotlineBriefInit = {
            chapter_count: chapterCount,
            ...(chapters.length > 0 ? { chapters } : {}),
            ...(questions.length > 0 ? { research_questions: questions } : {}),
            ...(notes === '' ? {} : { notes })
        };

        let brief!: PlotlineBrief;
        let chapterGroupIds: string[] = [];
        let summaryRef: string | null = null;
        let countSynced = false;

        await commitAs(
            ctx,
            'structurePlotlines',
            async () => {
                // Supersede every accepted brief for this PHRASE before the new one lands, in the same
                // commit: two `accepted` rows would make "the chapter set" ambiguous for every gate that
                // reads it. The scope is the phrase, not the Story — a book that restarted Phrase ② keeps
                // the retired brief of the phrase it replaced as audit history.
                const prior = ctx.store.plotlineBriefs
                    .list()
                    .filter((row) => row.phrase_id === phrase.id && row.status === 'accepted');

                for (const row of prior) {
                    ctx.store.plotlineBriefs.update(
                        row.id,
                        { status: 'draft' },
                        buildAttribution(ctx, `${why} (superseded by the brief derived from phrase seed ${currentHash})`)
                    );
                }

                // 1. THE BRIEF, as a draft: `createPlotlineBrief` stamps `seed_hash` from the phrase seed
                //    itself, so the row cannot claim a hash the caller invented.
                brief = createPlotlineBrief(ctx.store, story, phrase, init, buildAttribution(ctx, why));

                // 2. THE ACCEPTANCE, in the same commit: entries materialized, the count synced, status
                //    last (`acceptPlotlineBrief`'s own order). It re-checks the hash against the phrase,
                //    which is the guard against a race between this call's read and its write.
                const result = acceptPlotlineBrief(
                    ctx.store,
                    story,
                    brief,
                    buildAttribution(ctx, `${why}; the chapter set was accepted and materialized in one step`),
                    // T-5/P11: the attribution rides through, so the journal line under each new
                    // `chapter_n` row names the run that decided it should exist.
                    {}
                );

                brief = result.brief;
                chapterGroupIds = result.groups.map((group) => group.id);
                summaryRef = result.summary_ref;
                countSynced = result.chapter_count_synced;
            },
            expects
        );

        return ok(
            {
                id: brief.id,
                plotline_brief_id: brief.id,
                phrase_id: brief.phrase_id,
                seed_hash: brief.seed_hash,
                status: brief.status,
                fields: {
                    chapter_count: brief.chapter_count,
                    chapters: brief.chapters ?? [],
                    research_questions: brief.research_questions ?? [],
                    notes: brief.notes ?? null
                },
                // The gate the loop reads: the chapter entries this brief materialized. The Writer batch
                // is cut from exactly these rows, and `groupWorkTargets` never offers a chapter the book
                // has no entry for — so this list IS the arity every ChapterDraft answer is checked against.
                chapter_group_ids: chapterGroupIds,
                summary_ref: summaryRef,
                chapter_count_synced: countSynced,
                next: `the pipeline may now draft chapter contracts: ${chapterGroupIds.length} entr${chapterGroupIds.length === 1 ? 'y' : 'ies'} materialized for the ${brief.chapter_count} declared, and a Phrase ② seed edit re-arms the structuring`,
                current_rev: brief.rev
            },
            brief.rev,
            `Plotline Brief ${brief.id} accepted: ${brief.chapter_count} chapter(s) for phrase ${brief.phrase_id}`
        );
    }
};

/**
 * Phrase ②'s structuring surface — its own group in `registry.ts` for the same reason `knowledge` is
 * one: it belongs to no §8 table, and filing it under `editor` would make the conformance test claim
 * the §8.2 spec registers a tool it does not list.
 */
export const plotlinesTools: ToolDefinition[] = [structurePlotlines];
