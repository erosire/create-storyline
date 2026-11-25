/**
 * The Phase-1 research surface: `structureSeed`, `writeKnowledge`, `readKnowledge`,
 * `retireKnowledge` and `reportNoResearch` (documents/phase-1-research-pipeline.md §7.1).
 *
 * WHY THIS IS A GROUP OF ITS OWN AND NOT PART OF §8: the pipeline added three collections
 * (`knowledge`, `seed_briefs`, `sample_reviews`) and five tools, and it added them WITHOUT an
 * §8 section — §8's five tables are the pinned pre-pipeline catalogue, and registry.ts keeps
 * that surface separable so the conformance test can still diff it against the spec. These five
 * are still registered on every session (T-6a: "kind selects the brief and the permission row,
 * not the tool list"), and §7.2's three new rows are what decides who may call them.
 *
 * The guard discipline is the same as every §8 tool:
 *  - T-11 puts the enums (`importance`, `kind`) and the required fields in the schema, so a
 *    malformed call is refused with the accepted values rather than repaired;
 *  - T-5 makes `why` mandatory on every write and `buildAttribution` records it (P11);
 *  - T-4's `expects` guards the one read-modify-write call (`retireKnowledge`);
 *  - T-10 checks a citation names the claim it supports;
 *  - D-16's fingerprint dedupe turns a repeat into `seen_count + 1` and a refreshed source list
 *    instead of a second row, which is what makes an amnesiac Researcher's repeat cheap.
 *
 * P10/§7.2: the Researcher writes `knowledge` and nothing else in the story. Every other kind
 * reads it. `structureSeed` is the Editor's, and it writes a DERIVED `seed_briefs` row — never
 * `stories.idea`, which stays the Author's and C-14's reference (P5).
 *
 * D-51, the research waiver, lives in this file's two ends: `structureSeed` REQUIRES
 * `research_questions` (so "no research" is always a stated Editor decision, never an omission),
 * and `reportNoResearch` lets a Researcher that was dispatched anyway close the pass with a real
 * report and zero writes — which is what keeps that run out of S-4's no-op count.
 */
import {
    KNOWLEDGE_IMPORTANCE,
    KNOWLEDGE_KINDS,
    type KnowledgeEntry,
    type KnowledgeImportance,
    type KnowledgeKind,
    type KnowledgeSource,
    type SeedBrief,
    type StoryPhase
} from '../../shared/types';
import { seedHashOf } from '../../shared/seed-hash';
import { mustResolveRef } from './artifacts';
import {
    EXPECTS_ARG,
    KNOWLEDGE_IMPORTANCE_ENUM,
    KNOWLEDGE_KIND_ENUM,
    KNOWLEDGE_SOURCES_ARG,
    PHASE_ENUM,
    arr,
    str,
    whyArg
} from './schema';
import {
    buildAttribution,
    commitAs,
    normalizeForFingerprint,
    ok,
    okValue,
    repeatResult,
    ToolRefusal,
    whyOf
} from './utilities';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from './types';

/**
 * The knowledge dedupe key (§3.2): a stable hash of (story, normalised topic, normalised claim).
 *
 * WHY IT REUSES `seedHashOf`: the design asks for "the same FNV style as
 * `src/shared/seed-hash.ts`", and that module already exports the exact function — FNV-1a,
 * 32-bit, 8 hex chars, deterministic over UTF-16 code units. The NAME is historical (it was
 * written for the Seed); the algorithm is a general change-detector, and importing it avoids a
 * second hand-rolled hash that could drift from the first. The `k_` prefix keeps a knowledge
 * fingerprint distinguishable from a Seed hash in a log or a `knowledge_used` list.
 */
export function knowledgeFingerprint(storyId: string, topic: string, claim: string): string {
    return `k_${seedHashOf(`${storyId}|${normalizeForFingerprint(topic)}|${normalizeForFingerprint(claim)}`)}`;
}

/** The importance scale's order, most load-bearing first — the read's sort key (§7.1). */
const IMPORTANCE_RANK: Record<KnowledgeImportance, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3
};

/**
 * T-7's bounded-payload cap for `readKnowledge`: the tool is a lookup, not an export. 40 rows
 * covers what a deep-review Critic or the Editor reads in one turn; anything longer is a filter
 * the caller should have used (`importance`, `kind`, `phase`, `topic`).
 */
const KNOWLEDGE_READ_LIMIT = 40;

/** The `(retired)` marker `retireKnowledge` appends to `detail` — the audit trail, never a delete. */
const RETIRED_MARK = '(retired)';

/** Trims and drops blanks, keeping first-seen order — the array args' one normalisation. */
function cleanList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const text = entry.trim();
        if (!text || seen.includes(text)) continue;
        seen.push(text);
    }
    return seen;
}

/**
 * D-51: does this brief WAIVE phase ①'s research leg? An ABSENT field is not a waiver — a
 * `seed_briefs` row written before the field existed still needs its research pass. Only a stored,
 * empty list means "the Editor decided: no research".
 *
 * T10/F8: the reading is `Array.isArray(...) && length === 0`, character-for-character the loop's
 * (`loop/records.ts:researchWaived`). The earlier `!== undefined && length === 0` spelling agreed on
 * `undefined` but not on MALFORMED persisted data: a stored `''` or `0` has `length === 0` and would
 * read as a waiver HERE while the loop still owed the pass — the tool would tell the run "waived"
 * next to a Story the loop was still gating on research. Same predicate, same answer, no drift.
 *
 * This copy exists because the tool layer must not import the loop; the loop's dispatch/waiver gate
 * is the authority (§16.9.1 "One predicate"), and this mirror must stay byte-equal to it — change one,
 * change the other.
 */
function waivesResearch(brief: Pick<SeedBrief, 'research_questions'>): boolean {
    return Array.isArray(brief.research_questions) && brief.research_questions.length === 0;
}

/**
 * The stored `research_questions` value as the payload reports it: the list when the record HAS one,
 * and `null` when it does not (a row written before the field existed, or a malformed value the store
 * somehow carries). `null` is the payload's spelling of "this record states nothing", which is what
 * keeps a legacy row from being echoed back as `[]` and read as the Editor's waiver (T10/F1).
 */
function storedQuestions(brief: Pick<SeedBrief, 'research_questions'> | undefined): string[] | null {
    return brief !== undefined && Array.isArray(brief.research_questions) ? brief.research_questions : null;
}

/**
 * T-11/D-51 (T10/F9): read the Editor's research decision WITHOUT turning a blank into a waiver.
 *
 * `cleanList` is the right normalisation for the brief's descriptive lists — a stray blank entry there
 * costs nothing. It is the WRONG one here: `['']` cleaned to `[]` is a silent WAIVER, and
 * `['question', '   ']` cleaned to `['question']` silently changes the Researcher's scope. Both are
 * answers the Editor never gave, and D-51 exists so that phase ①'s whole research leg rests on a
 * stated decision. So a blank entry is a refusal naming the index and the fix, and legitimate
 * whitespace trimming and first-seen dedup stay (they change no decision).
 */
function researchQuestionsArg(ctx: ToolExecutionContext): string[] {
    const raw = ctx.args.research_questions;

    // The schema already refuses a non-array (T-11); this is the defence for a caller that reaches the
    // body another way, and it refuses rather than guessing `[]`, which would be a waiver.
    if (!Array.isArray(raw))
        throw new ToolRefusal('T-11', 'research_questions must be an array of question strings, or [].', {
            field: 'research_questions',
            expected: 'an array of string',
            received: raw,
            rule: 'D-51',
            fix: 'send the questions, or [] to state that the premise needs no fact from outside itself'
        });

    const questions: string[] = [];

    for (const [index, entry] of raw.entries()) {
        if (typeof entry !== 'string')
            throw new ToolRefusal('T-11', `research_questions[${index}] must be a string.`, {
                field: 'research_questions',
                index,
                received: entry,
                rule: 'D-51',
                fix: 'one question per entry, as a string'
            });

        const text = entry.trim();

        if (!text)
            throw new ToolRefusal(
                'T-11',
                `research_questions[${index}] is blank: a blank entry is neither a question nor the waiver, so the research decision on this brief is not stated`,
                {
                    field: 'research_questions',
                    index,
                    received: raw,
                    rule: 'D-51',
                    fix: 'drop the blank entry and send [] if no research is needed, or write the question it was meant to hold'
                }
            );

        if (!questions.includes(text)) questions.push(text);
    }

    return questions;
}

/** Reads one required string arg, trimmed. The schema already refused a missing one (T-11). */
function textArg(ctx: ToolExecutionContext, name: string): string {
    const raw = ctx.args[name];
    return typeof raw === 'string' ? raw.trim() : '';
}

// ── 1. structureSeed (§7.1, P5) ─────────────────────────────────────────────

/**
 * `structureSeed` — the Editor's projection of the Author's Seed into the machine-readable
 * `SeedBrief` every later stage runs on (§1 step 2, §3.3).
 *
 * P5 is preserved by construction: this tool writes `seed_briefs`, never `stories.idea`. The
 * `seed_hash` guard is what makes a stale brief impossible: the hash is computed from the Seed
 * the tool can see RIGHT NOW, so a brief derived from a Seed the Author has since edited is
 * refused naming P5 instead of silently describing a book nobody is writing.
 *
 * Idempotence: one ACCEPTED brief per Story. A call whose `seed_hash` already has an accepted
 * row returns a `repeat` result naming that row rather than writing a duplicate — the same Editor
 * re-dispatched after a lost answer must converge on the row it already wrote instead of
 * multiplying the briefs. A DIFFERENT hash supersedes: the old row becomes `draft` and the new
 * one is `accepted`, in the SAME commit (T-4's "one decision, one commit").
 *
 * D-51, the research decision: `research_questions` is a REQUIRED arg and is ALWAYS stored (as `[]`
 * when the premise needs no world facts outside itself). Requiring it is the whole point — phase ①'s
 * research leg is dispatched or waived by a decision the Editor made on the record, not inferred from
 * the title or the genre, and an omitted arg is a T-11 refusal rather than a silent waiver. Only a
 * PERSISTED brief can lack the field (a row written before D-51), and `loop/records.ts:researchGate`
 * reads that absence as `needed`, never as waived, so an upgrade cannot quietly drop a research pass.
 *
 * T10/F9 puts the other half of "stated, never inferred" on the ARG CONTENT: a blank entry (`['']`,
 * `['   ']`, or a blank among real questions) is a T-11 refusal naming the index, not something to
 * clean away. Cleaning it would manufacture a waiver the Editor never wrote (`['']` → `[]`) or quietly
 * narrow the Researcher's scope (`['q', '  ']` → `['q']`), and the loop's whole gate would move on an
 * entry that said nothing.
 */
const structureSeed: ToolDefinition = {
    name: 'structureSeed',
    description:
        "Write the Seed Brief: the Editor's derived, machine-readable projection of the Author's Seed (logline, protagonist, want/need, obstacle, stakes, setting, world rules, promise, tone, constraints, open questions) TOGETHER WITH the research decision — research_questions, the list the Researcher must work through, or [] to waive the research leg for this brief (D-51). Refuses a brief derived from a Seed that has moved (P5) and returns the existing brief instead of duplicating one for the same seed_hash. The Seed itself is never edited.",
    inputSchema: {
        type: 'object',
        properties: {
            seed_hash: str(
                'The hash of the Seed you read (readSeed prints seed_hash). A different value means the Seed changed after you read it, and the brief is refused naming P5.'
            ),
            logline: str("The Seed's own premise in one sentence: shorter than the Seed, losing nothing it says."),
            protagonist: str('Who the story is about, as the Seed names them.'),
            want: str('What the protagonist pursues.'),
            need: str('What the protagonist actually needs, when the Seed implies a gap between the two.'),
            obstacle: str('What stands in the way.'),
            // T3 — the Seed leaves a required scalar open by PASSING IT EMPTY, not by inventing a value.
            // `stakes` is a required arg (the row shape §4 has), so "the Seed never said" has to be a
            // legal value rather than a fabricated stake; an empty string already is one (the tool trims
            // and stores it), and the prompts render an empty field as the Seed leaving the choice open.
            // Saying so here is what stops an Editor inventing a stake to fill the box — and a Critic
            // later filing that invented absence as a C-14 defect.
            stakes: str(
                'What is lost if the protagonist fails. When the Seed does not say, pass an empty string and put the gap in open_questions: the Writer chooses it compatibly, and a stake the Seed never stated is not a promise the Summary owes.'
            ),
            setting: str('Where and when the story happens.'),
            world_rules: arr(
                'The rules this world holds to, restated from the Seed. A rule the Seed never states belongs in open_questions, not here.',
                str('One world rule.')
            ),
            promise: str('The promise the book makes to its reader, which the ending must pay (C-14).'),
            tone_hints: str('Voice, register and point of view the Seed implies.'),
            constraints: arr("What the story may not do — the Seed's own limits.", str('One constraint.')),
            open_questions: arr(
                'What the Seed leaves silent. A gap is a legitimate answer; an invented fact is not (§1 step 2).',
                str('One open question.')
            ),
            // D-51: the research decision is the Editor's, and it is a REQUIRED arg so "no research"
            // can only ever be a choice made on the record — an omitted field is a T-11 refusal, never
            // a silent waiver. `[]` waives phase ①'s research leg; a non-empty list dispatches the
            // Researcher with exactly these questions (§16.1's research gate).
            research_questions: arr(
                "What the Researcher must establish BEFORE any sample is drawn — [] when the premise needs no world facts outside itself (this WAIVES the research leg, D-51); ['question', ...] to dispatch it. An empty list is an answer, not an omission: never leave this out to dodge the decision, and never invent a question to fill it.",
                str('One research question.')
            ),
            expects: EXPECTS_ARG,
            why: whyArg('One-line reason this brief is the faithful reading of the Seed (T-5).')
        },
        required: [
            'seed_hash',
            'logline',
            'protagonist',
            'want',
            'obstacle',
            'stakes',
            'setting',
            'world_rules',
            'promise',
            'constraints',
            'open_questions',
            // D-51: required so the research decision is always stated; `[]` is a valid value (the
            // schema refuses `undefined`/`null`, not an empty array — T-11).
            'research_questions',
            'why'
        ]
    },
    writes: 'seed_briefs',
    level: 'write',
    mutating: true,
    // The call CREATES a brief (and supersedes the old one), so it is not a read-modify-write of
    // one row: `expects` is accepted for symmetry with §7.1's arg table but not required (T-4's
    // scope is a row the caller read, and this tool's guard is the `seed_hash`).
    expectsArg: false,
    primaryArg: 'seed_hash',
    // §7.1's owner is the Editor, and the seed_briefs row already gives the Editor `write`; the
    // grant is repeated so `describeTool` states the one kind the tool exists for, and `onlyKinds`
    // makes the refusal for every other kind a row-level answer, not a surprise.
    kinds: ['editor'],
    onlyKinds: ['editor'],
    requires: [
        'seed_hash',
        'logline',
        'protagonist',
        'want',
        'obstacle',
        'stakes',
        'setting',
        'world_rules',
        'promise',
        'constraints',
        'open_questions',
        'why'
    ],
    async execute(ctx, expects): Promise<ToolResult> {
        const declaredHash = textArg(ctx, 'seed_hash');
        // The current Seed's hash, computed here from the record the call is bound to. The agent's
        // value is compared, never trusted (P5/D-3b: the Seed is Author truth and the brief must
        // describe the Seed as it stands now).
        const currentHash = seedHashOf(ctx.story.idea);
        if (declaredHash !== currentHash) {
            throw new ToolRefusal(
                'P5',
                'structureSeed received a seed_hash that does not match the Seed this Story holds now: the Seed changed while you read it, so the brief would describe a book nobody is writing',
                {
                    field: 'seed_hash',
                    story_id: ctx.storyId,
                    received: declaredHash,
                    expected: currentHash,
                    fix: 're-derive the brief from the current Seed: readSeed prints its seed_hash, then send that value'
                }
            );
        }

        // T10/F9: the research decision is validated BEFORE the idempotence read below, so a call that
        // does not actually state one (a blank entry) can never be absorbed by a `repeat` of the row
        // that is already on the record — the Editor learns its call was malformed, and the stored
        // decision stays exactly what the earlier accepted call wrote.
        const questions = researchQuestionsArg(ctx);

        // D-16-style idempotence: an accepted brief for this exact Seed is the answer, not a
        // reason to write a second one. A re-dispatched Editor (or a run that lost its answer)
        // must converge on the same row.
        const accepted = ctx.store.seedBriefs
            .list()
            .find(
                (brief) =>
                    brief.story_id === ctx.storyId && brief.seed_hash === currentHash && brief.status === 'accepted'
            );
        if (accepted) {
            return repeatResult(
                `Seed Brief already accepted as ${accepted.id} for seed ${currentHash}`,
                {
                    seed_brief_id: accepted.id,
                    id: accepted.id,
                    seed_hash: accepted.seed_hash,
                    status: accepted.status,
                    // D-51: the repeat answers WITH the research decision it already recorded, so a
                    // re-dispatched Editor cannot "re-decide" the waiver in a second call. A row that
                    // predates the field reports `null` — the gate reads that as `needed`, not waived
                    // (T10/F8: `storedQuestions` is the payload's one reading, so a malformed stored
                    // value is echoed as "the record states nothing" instead of as an empty waiver).
                    research_questions: storedQuestions(accepted),
                    research_waived: waivesResearch(accepted),
                    current_rev: accepted.rev
                },
                { seed_brief_id: accepted.id }
            );
        }

        const why = whyOf(ctx);
        const brief: Omit<SeedBrief, 'id' | 'rev' | 'created_at' | 'updated_at'> = {
            story_id: ctx.storyId,
            seed_hash: currentHash,
            logline: textArg(ctx, 'logline'),
            protagonist: textArg(ctx, 'protagonist'),
            want: textArg(ctx, 'want'),
            obstacle: textArg(ctx, 'obstacle'),
            stakes: textArg(ctx, 'stakes'),
            setting: textArg(ctx, 'setting'),
            world_rules: cleanList(ctx.args.world_rules),
            promise: textArg(ctx, 'promise'),
            constraints: cleanList(ctx.args.constraints),
            open_questions: cleanList(ctx.args.open_questions),
            // D-51: ALWAYS written, even when empty — the absence of this field on a persisted brief
            // means "written before the field existed" (research still needed), so an empty list must
            // be stored as `[]` to read as a waiver. It is therefore NOT part of the "omit optional
            // fields" convention below, and it is NOT run through `cleanList`: `researchQuestionsArg`
            // (T10/F9) already refused any blank entry rather than cleaning `['']` into this waiver.
            research_questions: questions,
            status: 'accepted',
            // Optional fields are OMITTED rather than stored empty, so a record that never had a
            // tone hint looks exactly like one written before the field existed (§4's convention).
            ...(textArg(ctx, 'need') ? { need: textArg(ctx, 'need') } : {}),
            ...(textArg(ctx, 'tone_hints') ? { tone_hints: textArg(ctx, 'tone_hints') } : {})
        };

        let written!: SeedBrief;
        await commitAs(
            ctx,
            'structureSeed',
            async () => {
                // Supersede every accepted brief for this Story BEFORE the new one lands, in the
                // same commit: two `accepted` rows for one Story would make "the brief" ambiguous
                // and the pipeline's gate (`an accepted SeedBrief exists`) meaningless.
                const prior = ctx.store.seedBriefs
                    .list()
                    .filter((row) => row.story_id === ctx.storyId && row.status === 'accepted');

                for (const row of prior) {
                    ctx.store.seedBriefs.update(
                        row.id,
                        { status: 'draft' },
                        buildAttribution(ctx, `${why} (superseded by the brief derived from seed ${currentHash})`)
                    );
                }

                written = (await ctx.store.seedBriefs.create(brief, buildAttribution(ctx, why))) as SeedBrief;
            },
            expects
        );

        return ok(
            {
                id: written.id,
                seed_brief_id: written.id,
                seed_hash: written.seed_hash,
                status: written.status,
                fields: {
                    logline: written.logline,
                    protagonist: written.protagonist,
                    want: written.want,
                    need: written.need ?? null,
                    obstacle: written.obstacle,
                    stakes: written.stakes,
                    setting: written.setting,
                    world_rules: written.world_rules,
                    promise: written.promise,
                    tone_hints: written.tone_hints ?? null,
                    constraints: written.constraints,
                    open_questions: written.open_questions,
                    // D-51: the run must see the decision it just made, because the loop's next step
                    // differs — an empty list means no Researcher is coming, and the run should say so.
                    research_questions: written.research_questions ?? [],
                    // D-40/D-51: `research_waived` is the machine-readable form of the same line.
                    research_waived: waivesResearch(written)
                },
                // The gate the loop reads (§6.4 step 1): `sample_unit` is refused until an
                // accepted brief exists, and this line is how the run learns it just satisfied it.
                next: waivesResearch(written)
                    ? // D-51: the waiver is on the record, so phase ① moves straight to sampling.
                      'the pipeline may now sample: this brief waives the research leg (D-51), so no Researcher is dispatched for it — a Seed edit re-arms the structuring'
                    : 'the pipeline may now dispatch research against this brief, one pass over the research_questions you listed; a Seed edit re-arms the structuring',
                current_rev: written.rev
            },
            written.rev,
            `Seed Brief ${written.id} accepted for seed ${written.seed_hash}`
        );
    }
};

// ── 2. writeKnowledge (§7.1, D-16, T-10) ────────────────────────────────────

/**
 * T-10's citation check for one `sources[]` item: all three fields present and non-blank.
 * The schema already refuses a missing field (T-11), but the refusal here names T-10 and the
 * index, which is the rule the Researcher is judged by — and an EMPTY array is refused here
 * because `writeKnowledge` has nothing to source (unlike `proposeIdea`, where `[]` is legal).
 */
function parseSource(raw: unknown, index: number): KnowledgeSource {
    const label = `sources[${index}]`;
    if (typeof raw !== 'object' || raw === null)
        throw new ToolRefusal('T-11', `${label} must be an object with url_or_title, claim and accessed_at.`, {
            field: label,
            expected: '{url_or_title, claim, accessed_at}',
            fix: 'one citation per source (T-10)'
        });
    const item = raw as Record<string, unknown>;
    const urlOrTitle = typeof item.url_or_title === 'string' ? item.url_or_title.trim() : '';
    const claim = typeof item.claim === 'string' ? item.claim.trim() : '';
    const accessedAt = typeof item.accessed_at === 'string' ? item.accessed_at.trim() : '';
    if (!urlOrTitle || !claim || !accessedAt)
        throw new ToolRefusal(
            'T-10',
            `${label} needs url_or_title, the specific claim the source supports, and accessed_at — a source without a claim is a bookmark, and one without a date cannot be re-checked`,
            {
                field: label,
                rule: 'T-10',
                received: item,
                fix: 'cite the page you actually read, the claim it makes, and when you read it'
            }
        );
    return { url_or_title: urlOrTitle, claim, accessed_at: accessedAt };
}

/**
 * The source list after a repeat (D-16): the open row's citations win, in order, and a repeat
 * only ever ADDS the urls/titles it has not seen. A refreshed `accessed_at` on an existing
 * source is a real update (the claim was re-checked), so it replaces that entry in place.
 */
function mergeSources(existing: KnowledgeSource[], incoming: KnowledgeSource[]): KnowledgeSource[] {
    const merged = [...existing];
    for (const source of incoming) {
        const at = merged.findIndex((row) => row.url_or_title === source.url_or_title);
        if (at >= 0) merged[at] = source;
        else merged.push(source);
    }
    return merged;
}

/**
 * `writeKnowledge` — the Researcher's artifact (§3.2, §7.1).
 *
 * Dedupe (D-16): the fingerprint is (story, normalised topic, normalised claim). A repeat bumps
 * the open row's `seen_count` and merges the sources instead of opening a second row, and it also
 * takes the NEW `importance` — a re-triage is a real change (the fact did not move, the story's
 * dependence on it did). Everything lands in one commit.
 *
 * `author` records the role name/run that last wrote the row (P11), so the Author's knowledge pane
 * can say who stands behind a claim.
 */
const writeKnowledge: ToolDefinition = {
    name: 'writeKnowledge',
    description:
        'Record one sourced fact the story depends on: a topic, what class of fact it is, a checkable claim, the detail a writer needs, an importance that means something (critical/high reach the sampling prompt; normal/low never do), and at least one source naming the claim it supports (T-10). The same topic and claim again bumps seen_count and refreshes the sources instead of opening a second entry (D-16).',
    inputSchema: {
        type: 'object',
        properties: {
            topic: str('The subject key, normalised: one entry per topic + claim (e.g. "1880 service revolver").'),
            kind: KNOWLEDGE_KIND_ENUM,
            claim: str('One sentence that could be checked — the fact itself, not a summary of the page.'),
            detail: str('What a writer needs to know about it, including any uncertainty research could not settle.'),
            importance: KNOWLEDGE_IMPORTANCE_ENUM,
            sources: KNOWLEDGE_SOURCES_ARG,
            phase: PHASE_ENUM,
            why: whyArg('Why this fact is worth the Researcher spending the story on (T-5).')
        },
        required: ['topic', 'kind', 'claim', 'importance', 'sources', 'why']
    },
    writes: 'knowledge',
    level: 'write',
    mutating: true,
    expectsArg: false,
    primaryArg: 'topic',
    onlyKinds: ['researcher'],
    requires: ['topic', 'kind', 'claim', 'importance', 'sources', 'why'],
    async execute(ctx): Promise<ToolResult> {
        const topic = textArg(ctx, 'topic');
        const claim = textArg(ctx, 'claim');
        const kind = textArg(ctx, 'kind') as KnowledgeKind;
        const importance = textArg(ctx, 'importance') as KnowledgeImportance;

        // T-11: the enums are in the schema too, but the refusal has to name the set the tool
        // actually accepts, because a model that invented "important" learns nothing from "invalid".
        if (!(KNOWLEDGE_KINDS as readonly string[]).includes(kind))
            throw new ToolRefusal('T-11', `kind "${kind}" is not a knowledge kind.`, {
                field: 'kind',
                expected: [...KNOWLEDGE_KINDS],
                received: kind,
                fix: 'use one of the kinds in readKnowledge / describeTool'
            });
        if (!(KNOWLEDGE_IMPORTANCE as readonly string[]).includes(importance))
            throw new ToolRefusal('T-11', `importance "${importance}" is not an importance level.`, {
                field: 'importance',
                expected: [...KNOWLEDGE_IMPORTANCE],
                received: importance,
                fix: 'critical = the world breaks if ignored; high = a reader notices; normal/low = colour'
            });

        const rawSources = Array.isArray(ctx.args.sources) ? (ctx.args.sources as unknown[]) : [];
        // T-10: a knowledge entry with no citation is the improvised fact the rule exists to stop,
        // so an empty list is refused rather than stored as "unsourced".
        if (rawSources.length === 0)
            throw new ToolRefusal(
                'T-10',
                'writeKnowledge needs at least one source: every knowledge entry names what it stands on',
                {
                    field: 'sources',
                    rule: 'T-10',
                    fix: 'fetch the page you will cite, then send [{url_or_title, claim, accessed_at}]'
                }
            );
        const sources = rawSources.map(parseSource);

        const phase =
            typeof ctx.args.phase === 'string' && ctx.args.phase.trim() ? (ctx.args.phase as StoryPhase) : undefined;
        const detail = typeof ctx.args.detail === 'string' ? ctx.args.detail.trim() : '';
        const why = whyOf(ctx);
        const fingerprint = knowledgeFingerprint(ctx.storyId, topic, claim);
        const author = ctx.actorLabel;

        // D-16: the open row is any row with this fingerprint — a retired (`low`) row included,
        // because a repeat means the fact is live again and the new importance is the re-triage.
        const existing = ctx.store.knowledge
            .list()
            .find((row) => row.story_id === ctx.storyId && row.fingerprint === fingerprint);

        if (existing) {
            const merged = mergeSources(existing.sources, sources);
            const written = (await commitAs(
                ctx,
                'writeKnowledge',
                () =>
                    ctx.store.knowledge.update(
                        existing.id,
                        {
                            seen_count: existing.seen_count + 1,
                            importance,
                            sources: merged,
                            author,
                            // A repeat that states a detail refreshes it; a repeat that omits one
                            // keeps what the row already says (the first sighting's detail is
                            // usually the better-written one, and losing it on every bump would
                            // degrade the entry over time).
                            ...(detail ? { detail } : {}),
                            ...(phase ? { phase } : {})
                        },
                        buildAttribution(ctx, `${why} (already recorded)`)
                    ),
                []
            )) as KnowledgeEntry;

            return repeatResult(
                `Knowledge already recorded as ${written.id} (seen ${written.seen_count} times)`,
                {
                    knowledge_id: written.id,
                    id: written.id,
                    fingerprint: written.fingerprint,
                    topic: written.topic,
                    importance: written.importance,
                    kind: written.kind,
                    seen_count: written.seen_count,
                    sources: written.sources,
                    current_rev: written.rev
                },
                { knowledge_id: written.id }
            );
        }

        const created = (await commitAs(
            ctx,
            'writeKnowledge',
            () =>
                ctx.store.knowledge.create(
                    {
                        story_id: ctx.storyId,
                        kind,
                        // The stored topic is the normalised key, so a later read's filter matches
                        // the same row regardless of how the caller capitalised it.
                        topic: normalizeForFingerprint(topic),
                        claim,
                        importance,
                        sources,
                        fingerprint,
                        seen_count: 1,
                        author,
                        ...(detail ? { detail } : {}),
                        ...(phase ? { phase } : {})
                    } as Omit<KnowledgeEntry, 'id' | 'rev' | 'created_at' | 'updated_at'>,
                    buildAttribution(ctx, why)
                ),
            []
        )) as KnowledgeEntry;

        return ok(
            {
                knowledge_id: created.id,
                id: created.id,
                fingerprint: created.fingerprint,
                topic: created.topic,
                importance: created.importance,
                // §5's filter, stated so the Researcher can see the consequence of its triage.
                reaches_sampling: created.importance === 'critical' || created.importance === 'high',
                kind: created.kind,
                sources: created.sources.length,
                current_rev: created.rev
            },
            created.rev,
            `Knowledge ${created.id} recorded (${created.kind}, ${created.importance})`,
            {
                knowledge_id: created.id,
                notes: [
                    created.importance === 'critical' || created.importance === 'high'
                        ? 'critical/high entries enter the sampling prompt (§5); normal/low do not.'
                        : 'normal/low entries stay readable through readKnowledge but never enter the sampling prompt (§5).'
                ]
            }
        );
    }
};

// ── 3. readKnowledge (T-7) ──────────────────────────────────────────────────

/**
 * `readKnowledge` — the bounded lookup every kind holds (§7.1: "the tool is for the deep-review
 * Critic and the Editor"; the prompt compiler uses the same filter server-side).
 *
 * Ordering is deterministic so two runs read the same list: importance first (critical → low),
 * then newest (`created_at` desc), then id — no clock, no run id (T-7's bounded payload plus the
 * determinism §5's compiler needs). The cap is {@link KNOWLEDGE_READ_LIMIT}; `truncated` says
 * whether a filter is needed to see the rest.
 */
const readKnowledge: ToolDefinition = {
    name: 'readKnowledge',
    description:
        'Read the Story knowledge: sourced facts the Researcher recorded, filtered by importance, kind, phase or topic. Returns the most load-bearing entries first (critical → high → normal → low), newest first within a level, capped at 40 rows — filter if the answer is not in the page.',
    inputSchema: {
        type: 'object',
        properties: {
            importance: KNOWLEDGE_IMPORTANCE_ENUM,
            kind: KNOWLEDGE_KIND_ENUM,
            phase: PHASE_ENUM,
            topic: str('Only entries whose topic contains this text (case-insensitive).')
        },
        required: []
    },
    writes: 'knowledge',
    level: 'read',
    mutating: false,
    async execute(ctx): Promise<ToolResult> {
        const importance = ctx.args.importance === undefined ? '' : textArg(ctx, 'importance');
        const kind = ctx.args.kind === undefined ? '' : textArg(ctx, 'kind');
        const phase = ctx.args.phase === undefined ? '' : textArg(ctx, 'phase');
        const topic = ctx.args.topic === undefined ? '' : textArg(ctx, 'topic').toLowerCase();
        // The stored `topic` is the NORMALISED key (see writeKnowledge), so the needle is normalised
        // the same way before it is compared against it; the raw lowercase needle still matches the
        // claim, where the caller's own spelling may be what they remember.
        const topicKey = topic ? normalizeForFingerprint(topic) : '';

        // The two enum filters are `enum`-typed in the schema, so `validateArgs` already refuses an
        // unknown value (T-11). This second check is the defence for a caller that bypasses that
        // layer (an engine-side settlement reading the same filter): a typo that silently returned
        // everything would look like "no facts recorded", which is worse than a refusal.
        if (importance && !(KNOWLEDGE_IMPORTANCE as readonly string[]).includes(importance))
            throw new ToolRefusal('T-11', `importance "${importance}" is not an importance level.`, {
                field: 'importance',
                expected: [...KNOWLEDGE_IMPORTANCE],
                received: importance
            });
        if (kind && !(KNOWLEDGE_KINDS as readonly string[]).includes(kind))
            throw new ToolRefusal('T-11', `kind "${kind}" is not a knowledge kind.`, {
                field: 'kind',
                expected: [...KNOWLEDGE_KINDS],
                received: kind
            });

        const rows = ctx.store.knowledge
            .list()
            .filter((row) => row.story_id === ctx.storyId)
            .filter((row) => !importance || row.importance === importance)
            .filter((row) => !kind || row.kind === kind)
            .filter((row) => !phase || row.phase === phase)
            .filter((row) => !topic || row.topic.includes(topicKey) || row.claim.toLowerCase().includes(topic))
            .sort(
                (left, right) =>
                    IMPORTANCE_RANK[left.importance] - IMPORTANCE_RANK[right.importance] ||
                    right.created_at.localeCompare(left.created_at) ||
                    left.id.localeCompare(right.id)
            );

        const page = rows.slice(0, KNOWLEDGE_READ_LIMIT);
        return okValue({
            entries: page.map((row) => ({
                id: row.id,
                topic: row.topic,
                importance: row.importance,
                kind: row.kind,
                claim: row.claim,
                detail: row.detail ?? null,
                phase: row.phase ?? null,
                sources: row.sources,
                seen_count: row.seen_count,
                author: row.author,
                current_rev: row.rev
            })),
            total: rows.length,
            limit: KNOWLEDGE_READ_LIMIT,
            truncated: rows.length > page.length,
            note:
                rows.length > page.length
                    ? 'The page is bounded (T-7); filter by importance, kind, phase or topic to see the rest.'
                    : 'critical/high entries are the ones the sampling prompt carries (§5); normal/low stay here for the deep review.'
        });
    }
};

// ── 4. retireKnowledge (§7.1) ───────────────────────────────────────────────

/**
 * `retireKnowledge` — marking a stale fact instead of deleting it.
 *
 * AUDIT, NOT ERASURE (P11): the row survives with `importance: 'low'` and the retired mark
 * appended to `detail`, so the Author can still see what the book was once built on and the
 * fingerprint keeps catching a repeat. `expects` is required because this is a true
 * read-modify-write of one row (T-4): the Researcher read the entry in `readKnowledge`, and a
 * retirement based on a stale read is refused with the current record returned.
 *
 * Retiring an already-`low` row is refused: a second retire would append the mark a second time
 * and hide the fact that nothing changed. A re-triage back UP is `writeKnowledge`'s job (a repeat
 * carries the new importance), which is the only path that should revive an entry.
 */
const retireKnowledge: ToolDefinition = {
    name: 'retireKnowledge',
    description:
        'Retire a knowledge entry that is stale, superseded or no longer needed: it becomes low importance and its detail is marked (retired). Nothing is deleted — the audit keeps what the book was built on — and retiring an already-low entry is refused. Use expects with the id and rev you read.',
    inputSchema: {
        type: 'object',
        properties: {
            knowledge_id: str('The entry to retire (its id, or its topic as readKnowledge prints it).'),
            expects: EXPECTS_ARG,
            why: whyArg('Why this entry no longer deserves the Writer attention (T-5).')
        },
        required: ['knowledge_id', 'expects', 'why']
    },
    writes: 'knowledge',
    level: 'write',
    mutating: true,
    expectsArg: true,
    primaryArg: 'knowledge_id',
    onlyKinds: ['researcher'],
    requires: ['knowledge_id', 'expects', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const target = await mustResolveRef(ctx, ctx.args.knowledge_id, 'knowledge_id', ['knowledge']);
        const entry = target.record as KnowledgeEntry;
        const why = whyOf(ctx);

        if (entry.importance === 'low')
            throw new ToolRefusal(
                'T-11',
                `knowledge entry ${entry.id} is already low importance, so there is nothing to retire`,
                {
                    knowledge_id: entry.id,
                    importance: entry.importance,
                    fix: 'if the fact is live again, call writeKnowledge with the importance it deserves — a repeat re-triages the row'
                }
            );

        const detail = `${entry.detail ? `${entry.detail}\n\n` : ''}${RETIRED_MARK} ${why}`;
        const written = (await commitAs(
            ctx,
            'retireKnowledge',
            () =>
                ctx.store.knowledge.update(
                    entry.id,
                    { importance: 'low', detail },
                    buildAttribution(ctx, why),
                    expects
                ),
            expects
        )) as KnowledgeEntry;

        return ok(
            {
                knowledge_id: written.id,
                id: written.id,
                importance: written.importance,
                detail: written.detail ?? null,
                // §5: the entry just left the sampling filter, which is the point of retiring it.
                reaches_sampling: false,
                current_rev: written.rev,
                next: 'the entry stays readable for the audit; a repeat of the same claim re-triages it through writeKnowledge'
            },
            written.rev,
            `Knowledge ${written.id} retired (low)`
        );
    }
};

// ── 5. reportNoResearch (§7.1, D-51) ────────────────────────────────────────

/**
 * `reportNoResearch` — the Researcher's answer when a research pass finds NOTHING to record (D-51).
 *
 * WHY THIS EXISTS: D-51 lets the Editor waive the research leg by sending `research_questions: []`,
 * so a Researcher is normally not dispatched at all. But the waiver cannot be decided in advance of
 * the reading: a run that WAS dispatched (the Editor listed questions, and the pass then read the
 * brief, read `readKnowledge`, and concluded the premise needs no facts outside itself) has no write
 * to report with. Without this tool that run ends with no intentional result at all: S-4 counts the
 * silent close as a no-op turn against the Story, and the pass that ran records nothing about what it
 * decided. T10/§12 note: the closed run DOES close the gate as built (`records.ts:researchClosed` reads
 * any closed run for the brief's key), so the loop does not re-dispatch the question forever — what the
 * silence loses is the answer, not the gate. The tool gives the run a report to end with.
 *
 * ZERO WRITES, ON PURPOSE: the answer is a REPORT, not an artifact. It is deliberately not a
 * `Knowledge` row — `writeKnowledge` demands a citation (T-10) and an invented fact would be worse
 * than none (P7) — and it is not a task or a finding. The record of the decision is the run itself
 * plus the `rationale` this call carries in the run log.
 *
 * CLASSIFICATION (run/catalogue.ts): `level: 'read'` + `mutating: false`, and the name is listed in
 * `READ_TOOLS` so a D-38 panel agent answers it for real instead of proposing a write that does not
 * exist. It is ALSO in `REPORT_TOOLS`, which is what makes the run's `no_op === false` (S-4). Those
 * two sets are not contradictory: one answers "did this touch the store", the other "did this run
 * report".
 */
const reportNoResearch: ToolDefinition = {
    name: 'reportNoResearch',
    description:
        "Close a research pass with NOTHING to record: the premise needs no facts outside itself, or the questions this brief listed are already answered in the knowledge you read. This is a report, not a failure — it writes nothing (no Knowledge row, no task, no invented fact) and it is the only way a Researcher run ends without writeKnowledge. Name, in one line, what makes the premise self-contained or where the existing knowledge already answers the question.",
    inputSchema: {
        type: 'object',
        properties: {
            // Required, because "nothing needs research" is only a decision when it is stated: an
            // empty pass that cannot say why is the silence this tool exists to replace (D-51).
            rationale: str(
                'One line on WHY no outside fact is needed — what makes the premise self-contained, or which existing knowledge entry already answers the question. Never a fact you did not read (P7).'
            ),
            why: whyArg('One-line reason this pass is complete rather than merely empty (T-5).')
        },
        // The Seed Brief is NOT an arg: the server reads it from the record, so a run cannot answer a
        // brief that does not exist (the same "compare, never trust" rule structureSeed's seed_hash uses).
        required: ['rationale']
    },
    writes: 'knowledge',
    level: 'read',
    mutating: false,
    // §7.2 gives EVERY kind `read` on `knowledge`, so the row alone would let a Writer "answer" its
    // own research question; `onlyKinds` keeps this report the Researcher's alone (§8's narrowing).
    onlyKinds: ['researcher'],
    primaryArg: 'rationale',
    async execute(ctx): Promise<ToolResult> {
        const rationale = textArg(ctx, 'rationale');

        // The brief this pass answers, read from the record. `structureSeed` keeps at most ONE
        // accepted row per Story, so the last accepted row is the live one.
        const accepted = ctx.store.seedBriefs
            .list()
            .filter((row) => row.story_id === ctx.storyId && row.status === 'accepted');
        const brief = accepted[accepted.length - 1];

        // T10/F1 — the payload must not LIE about the waiver. `brief?.research_questions ?? []` made a
        // legacy row (no field) and a missing brief both look like a stored empty list, so the tool
        // answered `research_waived: true` with waiver prose for a Story the loop still OWES a research
        // pass to. D-51: absence is never a waiver. `storedQuestions` reports "the record states
        // nothing" as `null`, and `waivesResearch` (the loop's reading, `records.ts:researchWaived`)
        // says waived only for a stored, EMPTY array.
        const questions = storedQuestions(brief);
        const research_waived = brief !== undefined && waivesResearch(brief);
        const knowledge_rows = ctx.store.knowledge.list().filter((row) => row.story_id === ctx.storyId).length;

        return ok(
            {
                research: 'none',
                // What is being closed, stated from the record rather than from the call's args.
                seed_brief_id: brief?.id ?? null,
                seed_hash: brief?.seed_hash ?? null,
                research_questions: questions,
                research_waived,
                knowledge_rows,
                rationale,
                // D-51: the pass is closed by the run itself, so phase ①'s research gate is satisfied
                // and the loop's next generated work is sampling — not a second research dispatch.
                next: 'this research pass is closed with no Knowledge written; the loop may now sample the Seed Brief (D-51)'
            },
            undefined,
            `Research pass closed with nothing to record${brief ? ` (Seed Brief ${brief.id})` : ''}`,
            {
                notes: [
                    questions !== null && questions.length > 0
                        ? // The Editor's questions are answered by the reading itself: the loop records
                          // the pass as closed, so the same questions are never re-asked.
                          'The questions this brief listed are answered by the pass itself — no Knowledge row is expected, and the loop will not re-dispatch them.'
                        : questions !== null
                          ? // The waiver was already on the record; this report confirms it from the crew side.
                            'This brief waives the research leg (D-51): the report confirms the waiver from the Researcher side.'
                          : // T10/F1: no waiver is on the record, so what is being reported is the pass's OWN
                            // empty result — the loop closes the gate from the closed run, never from a decision
                            // the Editor did not make.
                            'No research waiver is on this record, so none is claimed: the empty result is this pass\'s own, and the loop closes the research gate from this closed run (D-51).',
                    'Nothing was written: this is a report, not a Knowledge row (T-10 needs a citation) and not a task.'
                ]
            }
        );
    }
};

/**
 * The Phase-1 research surface, in the order §7.1's table lists it — the group `registry.ts`
 * registers on every session (T-6a). `reportNoResearch` is last because it is the pass's closing
 * report, not another way to write (D-51).
 */
export const knowledgeTools: ToolDefinition[] = [
    structureSeed,
    writeKnowledge,
    readKnowledge,
    retireKnowledge,
    reportNoResearch
];
