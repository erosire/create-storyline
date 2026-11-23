// The Phase-1 prompt COMPILER (documents/phase-1-research-pipeline.md §5) — the one pure
// function that turns stored state into the Writer's first prompt and the screening Reader's
// one-turn prompt.
//
// WHY A COMPILER AND NOT THE BRIEF (S-2): a sampling run is one assistant turn with NO tools, so
// the assembled brief (role prompt, criteria, digest, tool etiquette, journal notes) is both
// larger and less relevant than the four things a sample actually needs — the Seed Brief, the
// critical/high Knowledge, the previous round's selected draft and the open fix tasks. The brief
// is for a run that ACTS on the book; this prompt is for a run that ANSWERS once.
//
// THE CACHE IS THE DESIGN CONSTRAINT (§5): every sample of one round sends a BYTE-IDENTICAL
// prompt, so a provider can serve the prefix from cache and the diversity comes only from the
// `seed`/sampling knobs. That is why:
//   - nothing here reads a clock, a run id or a revision id;
//   - knowledge is sorted by (importance rank, fingerprint) and tasks by (priority desc, id);
//   - the round number lives in headings only, never in `system` (round 1 and round 2 share the
//     cacheable system turn exactly).
// The `hash` is sha256(system + '\n\n--phase1--\n\n' + user), first 16 hex chars: the audit key a
// revision's `prompt_hash` carries so the Author can prove two samples shared a prefix (P11).
//
// SERVER-ONLY (`node:crypto`); the dashboard never imports this module.
import { createHash } from 'node:crypto';

import { ISSUE_LIST_SCHEMA_NAME, SUMMARY_SAMPLE_SCHEMA_NAME } from '../../shared/schemas';
// G-2: the criterion's `fix_hint` is the definition of done a fix task must carry, and the built-in
// roster is the only place it exists. Plain data, no library, so the server-only compiler can read it.
import { criterionById } from '../../shared/criteria';
import type { Criterion, Finding, KnowledgeEntry, Revision, SeedBrief, Story, Task } from '../../shared/types';
import type { Store } from '../store';
// T-10 / the G-9 fix: the fix block a Writer is graded on must contain ONLY rows the Writer can
// settle. `loop/records.ts:isWriterActionableFix` is the same predicate the sampler gate, the work
// queue and the round closure use, so the prompt, the offer and the certificate cannot drift apart.
// Server-only module, and `loop/records` has no run-layer imports — this adds no cycle.
import { isWriterActionableFix } from '../loop/records';

/** One compiled prompt: the two turns a no-tool run is given, and the hash that names them. */
export interface CompiledPrompt {
    system: string;
    user: string;
    hash: string;
}

/**
 * The knowledge filter §5 states once: only `critical` and `high` enter a sampling prefix.
 * `normal`/`low` stay readable through `readKnowledge` for the deep-review Reader, and they must
 * never make a prompt that is supposed to be byte-stable depend on research volume.
 */
export const PROMPT_KNOWLEDGE_IMPORTANCE: readonly KnowledgeEntry['importance'][] = ['critical', 'high'];

/** The same filter as a Set — the membership test runs per stored entry, not per prompt. */
const PROMPT_KNOWLEDGE_SET = new Set<KnowledgeEntry['importance']>(PROMPT_KNOWLEDGE_IMPORTANCE);

/** The sort key's order: `critical` before `high` (the array above IS the rank). */
const importanceRank = (importance: KnowledgeEntry['importance']): number => {
    const rank = PROMPT_KNOWLEDGE_IMPORTANCE.indexOf(importance);

    // `normal`/`low` (or an unknown value) sort last rather than throwing: a caller that has not
    // filtered yet must still get a deterministic order.
    return rank === -1 ? PROMPT_KNOWLEDGE_IMPORTANCE.length : rank;
};

/**
 * The screening contract §6.4 step 4 states, verbatim in the prompt: critical/high only, verbatim
 * quotes, `C-14`/`C-15`/`seed` as the criteria, and an empty list as a legitimate answer. The
 * schema caps `severity` at the transport (T-11); this text is what tells the model what the two
 * words MEAN, which no schema can.
 *
 * H1/R6 — the words are CALIBRATED TO THE PHASE. A Summary is a contract of facts and consequences;
 * its prose does not exist yet (phase ③ writes it). Before this calibration a screening Reader could
 * cost a comma or a preferred phrasing `high`, the round then resampled for a taste, and a second
 * Reader disliked the new phrasing — a hill that never converges because there is no top (the loop
 * the Author reported). Phrasing is now named as explicitly non-reportable, and the two severities
 * are defined over consistency, causality, timeline, world rules, motive and the Seed's own goal.
 */
const SCREEN_INSTRUCTION =
    'Report ONLY critical and high issues, and reserve those two words for what a Summary has to get RIGHT: ' +
    'a critical contradicts the Seed Brief or a critical Knowledge entry — a causal chain that does not cause, ' +
    'a timeline that cannot happen, a world rule the draft states and then breaks, a motive that does not explain ' +
    'the acts it grounds, or an ending that fails the Seed\u2019s goal. A high fails to deliver something the Seed ' +
    'Brief promises. Word choice, sentence structure, grammar, register and a preference for another phrasing of ' +
    'the same commitment are NOT issues at this phase — they are minor, nothing here ranks them, and the prose ' +
    'that carries them is written and judged in phase \u2462. Quote the offending field verbatim in `quote`, ' +
    'name the field in `location`, cite `C-14`, `C-15` or `seed` in `criterion`. Return {"issues":[]} when the ' +
    'draft holds.';

/**
 * H1/R2 — the fix-verification contract, stated where the fix list is: in the TARGET DRAFT section,
 * so the whole screening batch still shares one system turn (§5's cache argument covers screens too).
 *
 * WHY THIS TEXT HAS TO BE THIS PRECISE: the array it produces is what the selection is gated on
 * (`sample-select.ts:scoreSample`), so a Reader that marks a fix `resolved` because the sentence
 * reads better has bought the round a candidate that did not fix anything. `resolved` therefore
 * demands a quotation of the draft that shows the fix, `unknown` is the honest third answer, and a
 * rephrasing is named as NOT an answer.
 */
const FIX_VERIFICATION_INSTRUCTION =
    'The FIX TASKS section above names the changes this draft was asked to make. Answer with one ' +
    '`fix_verifications` entry for EVERY task it lists, and none for anything else: `fix_ref` is the task id ' +
    'inside the brackets, and `status` is `resolved` only when the draft now does what the task asks \u2014 quote ' +
    'the words of the draft that show it in `evidence` \u2014 `unresolved` when the defect the task describes is ' +
    'still there, and `unknown` when the draft neither shows the fix nor contradicts it. A different phrasing of ' +
    'the same commitment is not a resolved fix: judge the fact the task named, not the sentence that carries it. ' +
    'An `evidence` line you cannot fill from the draft is not a verdict \u2014 answer `unknown`.';

/**
 * H1/R1 — the revision contract a refinement round is held to, stated next to the base draft.
 *
 * This is the defect the Author named: a refinement sample that rewrote the Summary from scratch
 * discarded the parts the previous round had already settled, so the next round found (different)
 * defects and the loop could not converge. The rule is now explicit and it is stated in the same
 * prompt that carries the base draft, where the model is looking at it.
 */
const REVISION_CONTRACT =
    '- Change only what the FIX TASKS require, and only the coordinated minimum: the passages whose facts, ' +
    'causal links, timeline or consequences the fix actually touches.\n' +
    '- Keep the base draft\u2019s other commitments, fields and sentences as they are. A rewrite from scratch ' +
    'discards what the previous round already settled and starts the loop again \u2014 that is the round this ' +
    'pipeline exists to save.\n' +
    '- A fix is answered by the draft\u2019s CONTENT. Restating the same commitment in other words answers none of ' +
    'the tasks and will be marked `unresolved`.\n' +
    '- Nothing here is judged on style: wording and sentence shape are settled in phase \u2462, when the chapters ' +
    'are written.';

/** The template slug whose `writer` role prompt is the sampler's system turn (§8). */
export const SAMPLE_TEMPLATE_SLUG = 'writer-summary-sampler';

/** The template slug whose `reader` role prompt is the screening Reader's system turn (§8). */
export const SCREEN_TEMPLATE_SLUG = 'reader-screening';

/**
 * The output contract every no-tool run ends its system turn with. The schema NAME is the whole
 * point: the transport advertises the schema in `response_format` and this sentence tells the
 * model, in the same words, what a valid answer looks like — so a provider that downgrades to
 * `json_object` (§4.2's fallback) still knows the shape from the prompt.
 */
const outputContract = (schemaName: string): string =>
    `Answer with ONE JSON object matching the \`${schemaName}\` schema. You have no tools and exactly one turn. No prose outside the JSON.`;

/**
 * The one-line fallback when the catalogue has no role prompt for the slug (§8's templates are
 * Author-editable copies, so absence is possible). Stating the absence is S-2's rule — a silent
 * hole makes a fresh context invent its own instructions (T-6a's named failure mode).
 */
const fallbackRolePrompt = (slug: string): string =>
    `(no role prompt from "${slug}" was found in the catalogue, so this run is instructed by its output contract alone — treat the absence as a template defect to report, D-17a)`;

// ---------------------------------------------------------------------------
// Reads — every one of them pure over the store snapshot
// ---------------------------------------------------------------------------

/** The Story a prompt is compiled for, when it still exists. Absence is rendered, never thrown. */
const storyOf = (store: Store, storyId: string): Story | undefined => store.stories.get(storyId);

/**
 * The Story's ACCEPTED Seed Brief (§3.3, §6.4 gate 1). One accepted brief per Story by
 * construction; if a snapshot ever holds two, the newest `created_at` wins with the id as the
 * tie-break, so the choice is deterministic rather than list-order dependent.
 */
export function acceptedSeedBrief(store: Store, storyId: string): SeedBrief | undefined {
    const accepted = store.seedBriefs
        .list()
        .filter((brief) => brief.story_id === storyId && brief.status === 'accepted')
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));

    return accepted[accepted.length - 1];
}

/**
 * The Knowledge a prompt carries: this Story's `critical` and `high` entries, sorted by
 * importance rank then `fingerprint` (the stable dedupe key, so two runs over the same store
 * render the same lines in the same order).
 */
export function promptKnowledge(store: Store, storyId: string): KnowledgeEntry[] {
    return store.knowledge
        .list()
        .filter((entry) => entry.story_id === storyId && PROMPT_KNOWLEDGE_SET.has(entry.importance))
        .sort(
            (left, right) =>
                importanceRank(left.importance) - importanceRank(right.importance) ||
                left.fingerprint.localeCompare(right.fingerprint)
        );
}

/** D-21's prohibition is about SIBLING drafts; a screen names one revision, so it looks it up by id. */
const revisionOf = (store: Store, revisionId: string): Revision | undefined => store.revisions.get(revisionId);

/**
 * The Story's SELECTED Summary revision of `round` (§6.8): from round 2 the sampler improves
 * the draft the selector installed last round. Deterministic pick (lowest id) when a snapshot
 * somehow holds more than one selected row for that round.
 */
export function selectedSummaryRevision(store: Store, storyId: string, round: number): Revision | undefined {
    return store.revisions
        .list()
        .filter(
            (revision) =>
                revision.story_id === storyId &&
                revision.unit_kind === 'summary' &&
                revision.state === 'selected' &&
                revision.round === round
        )
        .sort((left, right) => left.id.localeCompare(right.id))[0];
}

/**
 * The OPEN `fix` tasks §5 puts in front of a refinement sample, ordered priority DESC then id.
 *
 * T-10 / the G-9 fix — WRITER-owned rows only. A `fix` task whose `owner_role` names someone else
 * is not something a draft can settle, and grading a draft against it is what made a round
 * unsamplable: story_16's round 2 demanded `task_187 (unresolved on revision_102)`, a row opened
 * `owner_role: 'researcher'` for the plotline G-9 flagged as "a reference I cannot resolve", and the
 * Reader panels correctly answered `unknown` — "the draft names no research finding it grounded
 * this in" — which sank both drafts and, with them, the wave. A Researcher prerequisite is settled
 * by recorded Knowledge (`work.ts:phase1FixPrerequisites`, `engine.ts:settleFixPrerequisites`); an
 * Author-owned row is a question, not a target. Filtering here — rather than relaxing the fix
 * certificate — is what keeps a draft from taking a certificate for a sentence that never resolved
 * anything.
 */
export function openFixTasks(store: Store, storyId: string): Task[] {
    return store.tasks
        .list()
        .filter((task) => task.story_id === storyId && task.kind === 'fix' && task.state === 'open')
        .filter(isWriterActionableFix)
        .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

/** `{fields: {...}}` is a Summary revision's body shape (§4.15, `src/server/tools/artifacts.ts`). */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

// ---------------------------------------------------------------------------
// Renderers — shared with ./brief, which carries the same two sections to tool runs
// ---------------------------------------------------------------------------

/**
 * One bullet list, or the stated absence. `world_rules`, `constraints` and `open_questions` are
 * arrays on the record; empty arrays render as "(none)" so the model can tell "the brief says
 * there are no constraints" from "the brief forgot the section".
 */
const bulletList = (items: readonly string[]): string =>
    items.length === 0 ? '(none)' : items.map((item) => `- ${item}`).join('\n');

/**
 * The Seed Brief as the prompt shows it (§5's shape). Every CONTENT field is rendered —
 * `world_rules`/`constraints`/`open_questions` as bullet lists — plus `seed_hash`, which is the
 * audit line proving which Seed the brief was derived from. `status` and `story_id` are record
 * bookkeeping (the status is `accepted` by the filter; the Story is the run's own scope), so they
 * are the only fields deliberately not restated.
 */
export function renderSeedBrief(brief: SeedBrief): string {
    const lines: string[] = [
        `seed_hash: ${brief.seed_hash}`,
        `logline: ${brief.logline}`,
        `protagonist: ${brief.protagonist}`,
        `want: ${brief.want}`
    ];

    // `need` is optional: a brief that does not state it says so rather than looking truncated.
    if (brief.need !== undefined && brief.need.trim().length > 0) lines.push(`need: ${brief.need}`);

    lines.push(`obstacle: ${brief.obstacle}`, `stakes: ${brief.stakes}`, `setting: ${brief.setting}`);
    lines.push(`world_rules:\n${bulletList(brief.world_rules)}`, `promise: ${brief.promise}`);

    if (brief.tone_hints !== undefined && brief.tone_hints.trim().length > 0) lines.push(`tone_hints: ${brief.tone_hints}`);

    lines.push(`constraints:\n${bulletList(brief.constraints)}`, `open_questions:\n${bulletList(brief.open_questions)}`);

    if (brief.notes !== undefined && brief.notes.trim().length > 0) lines.push(`notes: ${brief.notes}`);

    return lines.join('\n');
}

/**
 * One Knowledge line. Sources are joined by '; ' because T-10 counts citations, not rows — an
 * entry backed by two sources must read as two, and dropping either would weaken the audit.
 * `detail` is optional: the sampling prefix keeps it (it is the part a Writer leans on), while
 * the tool-run brief may omit it to stay inside E-3.
 */
export function renderKnowledgeLine(entry: KnowledgeEntry, options: { detail?: boolean } = {}): string {
    const sources =
        entry.sources.length === 0 ? '(none cited)' : entry.sources.map((source) => source.url_or_title).join('; ');
    const detail =
        options.detail === true && entry.detail !== undefined && entry.detail.trim().length > 0
            ? ` (${entry.detail})`
            : '';

    return `[${entry.fingerprint} · ${entry.importance} · ${entry.kind}] ${entry.topic}: ${entry.claim}${detail} — source: ${sources}`;
}

/**
 * The Knowledge block, or '' when there is nothing to say (§5: "omit the section when empty" —
 * an empty heading would make round 1's prompt differ from a Story with no research for no
 * informational reason).
 */
export function renderKnowledgeBlock(entries: readonly KnowledgeEntry[], options: { detail?: boolean } = {}): string {
    if (entries.length === 0) return '';

    return entries.map((entry) => renderKnowledgeLine(entry, options)).join('\n');
}

/**
 * A Summary revision's prose fields, rendered from `body.fields` DEFENSIVELY (§4.15 leaves
 * `body` open by unit kind). An unknown shape renders as a stated absence: a compiler that
 * crashed on a legacy row would strand the round, and one that guessed would put invented prose
 * in front of a Reader.
 */
export function renderSummaryBody(body: unknown): string {
    const record = asRecord(body);

    if (record === undefined) {
        return '(the revision body is not a field set — the draft cannot be shown; report nothing rather than guess)';
    }

    const fields = asRecord(record.fields);

    if (fields === undefined) {
        return '(the revision body carries no {fields} — the draft cannot be shown; report nothing rather than guess)';
    }

    const lines: string[] = [];
    // Fixed order, so two assemblies over the same record are byte-identical; a field the record
    // does not carry is omitted rather than rendered empty.
    for (const key of ['premise', 'promise', 'theme', 'tone', 'ending', 'world_rules']) {
        const value = fields[key];

        if (typeof value !== 'string' || value.trim().length === 0) continue;

        lines.push(`${key}: ${value}`);
    }

    return lines.length === 0 ? '(the revision body names no Summary field)' : lines.join('\n');
}

/**
 * One fix-task line, WITH the evidence behind it (H1/R1).
 *
 * The one-liner this replaces (`[id · priority n] title: detail`) was the whole of what a refinement
 * sample got, and it is why a resample could "answer" a fix by rewriting the paragraph it named: a
 * title says what to change, the FINDING's detail and evidence say what was actually wrong and where
 * the proof is, and the criterion's `fix_hint` says what done looks like (G-2). A Writer holding only
 * a title re-drafts; a Writer holding the evidence makes the smallest change that removes the defect.
 *
 * Every line below is optional except the header, and the order is FIXED (header, defect, evidence,
 * criterion question, hint) so two compiles over the same rows are byte-identical (§5's cache rule).
 */
export function renderFixTask(task: Task, finding?: Finding, criterion?: Criterion): string {
    const lines: string[] = [
        `[${task.id} · priority ${task.priority}${task.finding_ref === undefined ? '' : ` · ${task.finding_ref}`}] ${task.title}`
    ];

    // The task's own detail is the Editor's reading of the work (D-34 rewrote it into the Author's
    // surface); the finding's detail is the defect as the Reader saw it. Both travel: one says what
    // to do, the other says why, and a sample that only knows the first rewrites the wrong thing.
    if (task.detail !== undefined && task.detail.trim().length > 0) lines.push(`  work: ${task.detail.trim()}`);
    if (finding?.detail !== undefined && finding.detail.trim().length > 0)
        lines.push(`  defect: ${finding.detail.trim()}`);
    // D-15/T-11: the evidence line is the citable proof the defect exists. Without it the Writer is
    // being told "something is wrong here" and answers by redrafting the section.
    if (finding?.evidence !== undefined && finding.evidence.trim().length > 0)
        lines.push(`  evidence: ${finding.evidence.trim()}`);
    if (finding?.criterion_ref !== undefined && finding.criterion_ref.length > 0)
        lines.push(`  criterion: ${finding.criterion_ref}`);
    // G-2: the smallest change that would satisfy the criterion — the fix's definition of done.
    if (criterion?.fix_hint !== undefined && criterion.fix_hint.trim().length > 0)
        lines.push(`  done looks like: ${criterion.fix_hint.trim()}`);

    return lines.join('\n');
}

/** The fix tasks a refinement prompt carries, in §5's stable order: priority DESC, then id. */
const sortFixTasks = (tasks: readonly Task[]): Task[] =>
    [...tasks].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));

/**
 * The fix tasks ONE compiled prompt carries.
 *
 * `fixRefs` (the Work Item's `fixRefs`, H1) wins when the caller names it: the job recorded the list
 * when it was queued, so every sample of a round renders the SAME block even if a task is confirmed
 * mid-round, and the screening verdict is graded against exactly the list the Reader was handed
 * (`records.ts:sampleFixDemand`). Without it the caller means "whatever is open now" — the Story's
 * open `fix` tasks, which is what `brief.ts` renders for a tool run.
 */
export function promptFixTasks(store: Store, storyId: string, fixRefs?: string[]): Task[] {
    if (fixRefs === undefined) return sortFixTasks(openFixTasks(store, storyId));

    const wanted = new Set(fixRefs);

    // Rows are read from the store rather than trusted from the job: a task the Editor closed while
    // the job waited renders its stored truth, and a ref that no longer resolves simply drops out.
    // The OWNER filter is the same one `openFixTasks` applies: an explicitly named row that a
    // Researcher or the Author owns still cannot be graded against a draft, so a stale `fix_refs`
    // list (a Work Item armed before the split, or a resumed round) reads as absent here instead of
    // pulling an unanswerable target into the Writer's contract and the Reader's panel.
    return sortFixTasks(
        store.tasks
            .list()
            .filter((task) => task.story_id === storyId && task.kind === 'fix' && wanted.has(task.id))
            .filter(isWriterActionableFix)
    );
}

/** The criterion a fix answers, resolved for its `fix_hint` (G-2) — undefined for a custom id. */
const criterionOf = (criterionRef: string | undefined): Criterion | undefined =>
    criterionRef === undefined || criterionRef.length === 0 ? undefined : criterionById(criterionRef);

/**
 * The fix-task block both prompts share (§6.8): every task with its finding's detail and evidence and
 * the criterion's definition of done. `''` when the round carries no fixes, so the caller can omit the
 * section instead of rendering an empty heading.
 */
export function renderFixTaskBlock(store: Store, storyId: string, fixRefs?: string[]): string {
    return promptFixTasks(store, storyId, fixRefs)
        .map((task) =>
            renderFixTask(
                task,
                task.finding_ref === undefined ? undefined : store.findings.get(task.finding_ref),
                criterionOf(task.criterion_ref)
            )
        )
        .join('\n');
}

/**
 * The Seed section: the ACCEPTED Seed Brief when one exists, else the raw Seed with P5's note.
 * The fallback is load-bearing, not defensive noise — a Story whose Editor has not structured
 * the Seed yet must still compile (the dispatch gate refuses sampling, but a mis-ordered sweep
 * gets a truthful prompt instead of a crash).
 */
function seedSection(store: Store, storyId: string): { heading: string; body: string } {
    const brief = acceptedSeedBrief(store, storyId);

    if (brief !== undefined) return { heading: '## SEED BRIEF', body: renderSeedBrief(brief) };

    const seed = storyOf(store, storyId)?.idea;

    return {
        heading: '## SEED',
        body: `${seed === undefined ? '(no Story row and no Seed Brief — there is nothing to sample from)' : seed}\n(no structured brief yet — the Seed itself is law, P5)`
    };
}

/** The knowledge section, or undefined when the Story has no critical/high entries. */
function knowledgeSection(store: Store, storyId: string): { heading: string; body: string } | undefined {
    const body = renderKnowledgeBlock(promptKnowledge(store, storyId), { detail: true });

    return body === '' ? undefined : { heading: '## KNOWLEDGE — critical and high only', body };
}

/** The role prompt of one template slug + role name, with the stated fallback (§8). */
function rolePromptOf(store: Store, slug: string, roleName: string): string {
    const template = store.templates.list().find((candidate) => candidate.name === slug);
    const role = template?.roles?.find((candidate) => candidate.name === roleName);
    const prompt = role?.prompt?.trim() ?? '';

    return prompt.length > 0 ? prompt : fallbackRolePrompt(slug);
}

/** Joins the parts with one blank line and never leaves a trailing newline (hash stability). */
const joinSections = (sections: Array<{ heading: string; body: string }>): string =>
    sections.map((part) => `${part.heading}\n${part.body}`).join('\n\n');

// ---------------------------------------------------------------------------
// The two compiled prompts
// ---------------------------------------------------------------------------

/**
 * The Writer's first prompt for one sampling round (§5).
 *
 * Round 1 carries the Seed Brief + the critical/high Knowledge. From round 2 it additionally carries
 * the previous round's SELECTED draft, the contract that keeps the round a REVISION of it, and the
 * open fix tasks with their evidence — the refinement is an instruction to change specific facts in a
 * concrete draft, not to have another go (H1/R1, and the endless-rewrite loop the Author reported).
 * The `system` turn is identical for every round: the round number must never enter the cacheable
 * prefix (§5).
 *
 * `opts.fixRefs` (H1) pins the fix list to the one the sampling JOB carried, so every sample of a
 * round sends the same bytes even if the Editor confirms another finding mid-round.
 */
export function compileSamplePrompt(
    store: Store,
    storyId: string,
    opts: { round: number; fixRefs?: string[] }
): CompiledPrompt {
    const round = Number.isFinite(opts.round) && opts.round > 0 ? Math.floor(opts.round) : 1;

    const system = `${rolePromptOf(store, SAMPLE_TEMPLATE_SLUG, 'writer')}\n\n${outputContract(SUMMARY_SAMPLE_SCHEMA_NAME)}`;

    const sections: Array<{ heading: string; body: string }> = [seedSection(store, storyId)];

    const knowledge = knowledgeSection(store, storyId);

    if (knowledge !== undefined) sections.push(knowledge);

    if (round > 1) {
        const base = selectedSummaryRevision(store, storyId, round - 1);

        sections.push({
            heading: '## BASE REVISION (the selected draft of the previous round — revise it, do not rewrite it)',
            body:
                base === undefined
                    ? '(no selected Summary revision was found for the previous round — write the best draft the brief allows and treat its absence as a sweep defect)'
                    : renderSummaryBody(base.body)
        });

        sections.push({ heading: '## REVISION CONTRACT (what this round changes, and what it keeps)', body: REVISION_CONTRACT });

        const fixes = renderFixTaskBlock(store, storyId, opts.fixRefs);

        sections.push({
            heading: '## FIX TASKS (every one must be visible in the new draft, by content, and each is judged by its id)',
            body: fixes === '' ? '(none open)' : fixes
        });
    }

    const user = joinSections(sections);

    return { system, user, hash: hashPhase1Prompt(system, user) };
}

/**
 * The screening Reader's one-turn prompt for ONE competing sample (§6.4 step 4).
 *
 * D-21 keeps the sibling samples out of a Reader's view, so the prompt names one draft's FIELDS
 * (never its revision id — ids are volatile and the prompt must be reproducible). The closing
 * instruction is the screening contract: critical/high only, verbatim quotes, `C-14`/`C-15`/`seed`
 * as the criteria, and an empty list as a legitimate answer.
 *
 * H1/R2 — when the candidate REPLACES a selected draft (its round carries fix tasks), the Reader is
 * also handed the draft it replaces and the fixes that were asked of it, and must answer for every
 * fix by id (`fix_verifications`). This is the same run that ranks the round, not a second pipeline:
 * the Reader that compares the two texts is the one entitled to say whether the gap closed, and the
 * engine gates the selection on its answer (`sample-select.ts:scoreSample`). A round-1 screen carries
 * no such section, so a clean first round costs exactly what it used to.
 */
export function compileScreenPrompt(
    store: Store,
    storyId: string,
    revisionId: string,
    opts: { fixRefs?: string[] } = {}
): CompiledPrompt {
    const system = `${rolePromptOf(store, SCREEN_TEMPLATE_SLUG, 'reader')}\n\n${outputContract(ISSUE_LIST_SCHEMA_NAME)}`;

    const sections: Array<{ heading: string; body: string }> = [seedSection(store, storyId)];

    const knowledge = knowledgeSection(store, storyId);

    if (knowledge !== undefined) sections.push(knowledge);

    const revision = revisionOf(store, revisionId);
    const fixes = renderFixTaskBlock(store, storyId, opts.fixRefs);

    // The sections that make a round-N screen a VERIFICATION rather than an opinion all sit before
    // TARGET DRAFT: every sample of the round shares those bytes, so the screening batch still reads
    // one cache prefix, and only the candidate differs (§5's argument applies to screens too).
    if (fixes !== '') {
        const base = selectedSummaryRevision(store, storyId, Math.max(1, (revision?.round ?? 1) - 1));

        sections.push({
            heading: '## SELECTED DRAFT (the text the target draft below replaces — judge whether it was actually revised)',
            body:
                base === undefined
                    ? '(no selected Summary revision was found for the previous round — judge the target draft against the Seed, and mark every fix `unknown`)'
                    : renderSummaryBody(base.body)
        });

        sections.push({
            heading: '## FIX TASKS (verify every one against the target draft, by its id)',
            body: fixes
        });
    }

    const draft =
        revision === undefined
            ? '(no target draft was found for this screen — a screening run with no draft can judge nothing; answer with {"issues":[]})'
            : renderSummaryBody(revision.body);

    // The screening instruction rides in the TARGET DRAFT section rather than the system turn:
    // it talks about "the draft above", and the system text must stay identical across the whole
    // screening batch (§5's cache argument applies to screens too — they share one prefix).
    sections.push({
        heading: '## TARGET DRAFT',
        body: `${draft}\n\n${SCREEN_INSTRUCTION}${fixes === '' ? '' : `\n\n${FIX_VERIFICATION_INSTRUCTION}`}`
    });

    const user = joinSections(sections);

    return { system, user, hash: hashPhase1Prompt(system, user) };
}

/**
 * The prompt hash §5 pins: sha256 over `system + '\n\n--phase1--\n\n' + user`, first 16 hex chars.
 * The separator is fixed text rather than a concatenation, so no two pairs (system, user) can
 * collide by shifting a boundary. Exported because the executor and the loop's settlement step
 * both need to name a prompt without recompiling it.
 */
export function hashPhase1Prompt(system: string, user: string): string {
    return createHash('sha256').update(`${system}\n\n--phase1--\n\n${user}`, 'utf8').digest('hex').slice(0, 16);
}
