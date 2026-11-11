// S-2 brief assembly — the whole memory a run will ever have, read out of the store and
// nothing else (P1, P3, D-13).
//
// WHY THIS IS A MODULE OF ITS OWN: the brief is the product's anti-context-rot mechanism.
// P2 guarantees a fresh context every turn, so everything a judgment needs has to be in this
// text or the judgment is unfounded; E-1 caps what it may contain ("Digest + the artifact
// under review + the criteria", roughly constant regardless of book length); E-3 says it must
// FIT one judgment or one bounded edit set. Both directions are load-bearing, so the section
// list, the exclusions, and the trim order are all written down here where they can be read.
//
// THE EXCLUSIONS ARE THE POINT (D-21, E-1, P2, P13):
//   - a Writer's brief names the unit and its contract, NEVER its sibling drafts (D-21) — so
//     revision bodies appear only for the kinds allowed to see them (select / merge);
//   - another chapter's prose never appears: the Digest carries its one-line summary instead
//     (E-1, D-13), which is what keeps a 40-chapter book briefable at all;
//   - run rows never appear in the change notes (see {@link eventBelongsToStory}): a run's own
//     bookkeeping is not a story fact (P3), and including it would make the brief — and the
//     `brief_hash` recorded on the run row — depend on when the run was spawned.
//
// DETERMINISM IS A CONTRACT, NOT A NICETY: `runs.brief_hash` (§4.13) is the audit record of
// what a run was told, and D-12a's "any past Digest is reconstructible" promise depends on the
// brief being a pure function of stored state. So nothing here reads a clock: every value in
// the text comes from a record or from the journal.
import { createHash } from 'node:crypto';

import { LEVELS, LEVEL_LABELS, LEVEL_QUESTIONS, PER_CHAPTER, type CriterionLevel } from '../../shared/criteria';
import {
    type Chapter,
    type ChapterSection,
    type Criterion,
    type Digest,
    type Goal,
    type Idea,
    type Plotline,
    type Revision,
    type RoleKind,
    type Story,
    type StoryPhase
} from '../../shared/types';
import { chapterContent } from '../../shared/chapter';
import type { CommitEvent, Store } from '../store';
import { REPORT_TOOLS } from './catalogue';
import { permissionLine, type ResolvedHarness } from './harness';
import type { WorkItem } from './types';

// ---------------------------------------------------------------------------
// Budget and clipping
// ---------------------------------------------------------------------------

/**
 * E-3: the brief must fit the job. 12k characters (~3k tokens) is the ceiling this build
 * pins — comfortably above a Digest + one chapter + one job, and low enough that a run cannot
 * arrive already context-rotted (P2's whole purpose). E-0 forbids reading anything as a COST
 * limit; this is a legibility bound, not a budget, and the proof of the distinction is what
 * happens when it is exceeded: the change notes are dropped and the reading is not.
 */
export const BRIEF_CHAR_BUDGET = 12_000;

/** How many journal lines are scanned for change notes before the newest N are chosen (S-2). */
const CHANGE_NOTE_SCAN = 50;

/**
 * The trim ladder, in order. Its last entry is E-0's promise in code: once the change notes
 * are gone and the fields are clipped to 400 characters, the brief STOPS SHRINKING and goes
 * over budget, because the Seed, the Digest, the criteria and the artifact ARE the brief
 * (D-13, E-1) and dropping one to hit a character count would trade a rule for a number.
 */
const TRIM_LADDER = [
    { notes: 10, clip: Number.POSITIVE_INFINITY },
    { notes: 5, clip: Number.POSITIVE_INFINITY },
    { notes: 0, clip: Number.POSITIVE_INFINITY },
    { notes: 0, clip: 1_000 },
    { notes: 0, clip: 400 }
];

/** The heading a select/merge brief carries its competing drafts under (D-21). */
export const REVISIONS_HEADING = 'COMPETING REVISIONS (D-21 — you and the Author see these; no other run does)';

/** Clips a stored field for the brief, counting what was cut so the agent knows it is partial. */
function clip(value: string, max: number): string {
    if (!Number.isFinite(max) || value.length <= max) return value;

    return `${value.slice(0, max)}\n… [clipped for the brief: ${value.length - max} more characters — read the full record with the read tool]`;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

/** `# HEADING` + body, with the blank line that keeps the whole brief scannable. */
const section = (heading: string, body: string): string => `# ${heading}\n${body.trim() || '(none)'}\n`;

/** Renders a `key: value` block, skipping fields that hold nothing (a blank line is noise). */
function fieldBlock(fields: [string, unknown][], fieldClip: number): string {
    const lines: string[] = [];

    for (const [key, value] of fields) {
        if (value === undefined || value === null) continue;

        if (typeof value === 'string') {
            if (value.trim().length === 0) continue;
            lines.push(`${key}: ${clip(value, fieldClip)}`);

            continue;
        }

        lines.push(`${key}: ${JSON.stringify(value)}`);
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reads the sections are built from
// ---------------------------------------------------------------------------

/**
 * The Goal the Story measures against (G-4: every crew's brief carries the SAME target). Falls
 * back to any Goal row owned by the Story, because `goal_ref` is optional in §4.1.
 */
function goalFor(store: Store, story: Story): Goal | undefined {
    if (story.goal_ref) {
        const referenced = store.goals.get(story.goal_ref);

        if (referenced) return referenced;
    }

    return store.goals.list().find((goal) => goal.story_id === story.id);
}

/**
 * The CURRENT Digest (D-12a: one current record plus history). `stories.digest_rev` is the
 * engine's pointer, so it decides when it matches; otherwise the highest `rev` is the current
 * one, because §4.8 says the rev "advances with the commits it summarises".
 */
function currentDigest(store: Store, story: Story): Digest | undefined {
    const owned = store.digests.list().filter((digest) => digest.story_id === story.id);

    if (owned.length === 0) return undefined;

    return (
        owned.find((digest) => digest.rev === story.digest_rev) ??
        owned.reduce((best, digest) => (digest.rev > best.rev ? digest : best))
    );
}

/**
 * §5.2's level grouping, narrowed to what THIS job judges: `chapters` is the phase's level and
 * `whole` joins it only for the whole-Story pass, because §5.2 reports the whole-Story level
 * separately ("they fail for different reasons").
 */
function levelsFor(item: WorkItem, phase: StoryPhase): CriterionLevel[] {
    if (phase === 'summary') return ['summary'];
    if (phase === 'plotlines') return ['plotlines'];

    return item.kind === 'whole_story_check' ? ['chapters', 'whole'] : ['chapters'];
}

/**
 * The criteria a level reports. Placement comes from the §5.2 grouping ({@link LEVELS}) applied
 * to the STORY'S OWN Goal rows, not to the built-in roster, because G-1 lets the Author toggle,
 * delete and add criteria per Story. A criterion the Author added is not in §5.2's table at
 * all, so it is carried by the Story's current phase level — an Author-added criterion nobody
 * briefed is a criterion the crew cannot pass.
 */
function criteriaForLevel(pool: readonly Criterion[], level: CriterionLevel, primary: CriterionLevel): Criterion[] {
    const placed = pool.filter((criterion) => (LEVELS[level] as readonly string[]).includes(criterion.id));

    if (level !== primary) return placed;

    const known = new Set<string>([...Object.values(LEVELS).flat(), ...PER_CHAPTER]);
    const authored = pool.filter((criterion) => !known.has(criterion.id));

    return [...placed, ...authored];
}

/** One criterion line: the id, the flags, the question a fresh reviewer answers, and the fix hint (G-2). */
function criterionLine(criterion: Criterion): string {
    const flags = [
        criterion.hard ? 'HARD' : 'soft',
        criterion.checker === 'code' ? 'server-checked — do not grade it' : 'you judge it'
    ].join(' · ');

    return [
        `- ${criterion.id} · ${flags}`,
        `  ${criterion.label}`,
        `  Q: ${criterion.question}`,
        `  If it fails: ${criterion.fix_hint}`
    ].join('\n');
}

/** Renders the prose sections with their ids — D-7 addressing, so a reviewer edits one paragraph, not the chapter. */
function renderSections(sections: ChapterSection[], fieldClip: number): string {
    if (sections.length === 0) return '(no sections yet — the chapter is an outline)';

    return sections
        .map((entry) => {
            // T-2/D-37a: an `author` span is propose-only for every agent (P9), so the rule is
            // written next to the span, where the agent would otherwise hit the refusal blind.
            const marker =
                entry.origin === 'author'
                    ? ' ORIGIN=AUTHOR → propose only, never rewrite (P9, T-2)'
                    : ` origin=${entry.origin}`;
            const audit = entry.last_run_ref
                ? ` (last written by ${entry.last_run_ref}${entry.last_why ? `: ${entry.last_why}` : ''})`
                : '';

            return `[section_id=${entry.id}${marker}${audit}]\n${clip(entry.text, fieldClip)}`;
        })
        .join('\n\n');
}

function renderPlotline(plotline: Plotline, fieldClip: number): string {
    // P4: the contract itself, not a summary of it — the loop's only question is answerable against it.
    return fieldBlock(
        [
            ['plotline_id', plotline.id],
            ['order', plotline.order],
            ['heading', plotline.heading],
            ['must_happen', plotline.must_happen],
            ['must_change', plotline.must_change],
            ['pov', plotline.pov],
            ['setups', plotline.setups],
            ['payoffs', plotline.payoffs],
            ['contract_locked', plotline.contract_locked ? 'true — propose only, never rewrite (D-6)' : 'false'],
            ['needs_recheck', plotline.needs_recheck || undefined]
        ],
        fieldClip
    );
}

function renderSummaryFields(store: Store, storyId: string, fieldClip: number): string {
    const summary = store.summaries.list().find((candidate) => candidate.story_id === storyId);

    if (summary === undefined) return '(no Summary record yet)';

    return fieldBlock(
        [
            ['summary_id', summary.id],
            ['chapter_count', `${summary.chapter_count} — Author-declared, read-only for every agent (D-3b)`],
            ['premise', summary.premise],
            ['promise', summary.promise],
            ['theme', summary.theme],
            ['tone', summary.tone],
            ['ending', summary.ending],
            ['world_rules', summary.world_rules],
            ['locked', summary.locked ? 'true — P5: every agent write is refused' : 'false']
        ],
        fieldClip
    );
}

/**
 * The competing drafts — D-21: side by side to an Editor and to the Author, and to nobody else.
 * Body is JSON-rendered when it is not a string, because §4.15 leaves `body`'s shape to the
 * unit kind and a plotline draft body is a field set, not prose.
 */
function renderCompetingRevisions(store: Store, unitRef: string, fieldClip: number): string {
    if (!unitRef) return '';

    const competing = store.revisions
        .list()
        .filter((revision: Revision) => revision.unit_ref === unitRef && revision.state === 'competing')
        // §4.15 has no ordering field for drafts; the id is the only stable one, and a brief
        // that ordered them differently each assembly would make "which draft is 1" meaningless.
        .sort((left, right) => left.id.localeCompare(right.id));

    if (competing.length === 0) return '(no competing revisions for this unit)';

    return competing
        .map((revision) => {
            const verdicts = revision.verdict_refs.length > 0 ? revision.verdict_refs.join(', ') : 'none';
            const body = typeof revision.body === 'string' ? revision.body : JSON.stringify(revision.body ?? '');

            // T-7: bounded in the brief too — an Editor reads the drafts it is choosing
            // between, not the whole book around them (E-1).
            return [
                `revision_id=${revision.id} · state=${revision.state} · verdicts: ${verdicts}`,
                clip(body, fieldClip)
            ].join('\n');
        })
        .join('\n\n');
}

// ---------------------------------------------------------------------------
// What changed since the last pass (S-2) — read out of the journal
// ---------------------------------------------------------------------------

/** The record's `story_id`, when the record is still present (a patch does not always carry it). */
function storyIdOfRecord(store: Store, id: string): string | undefined {
    const resolved = store._resolveId(id);

    if (resolved?.record === undefined) return undefined;

    const storyId = (resolved.record as unknown as Record<string, unknown>).story_id;

    return typeof storyId === 'string' ? storyId : undefined;
}

/** Does this journaled event belong to this Story? (P3: a Story IS its records, so its events too.) */
function eventBelongsToStory(store: Store, event: CommitEvent, storyId: string): boolean {
    // Run bookkeeping is not a story fact, and excluding it is also what makes the brief — and
    // therefore `runs.brief_hash` — independent of the run's own spawn and heartbeats (S-4a).
    if (event.collection === 'runs') return false;

    // The Story row IS the Story (§4.1 has no `story_id` field on it), so its own edits — the
    // Author's phase change, a title rename — are decided by id.
    if (event.collection === 'stories') return event.id === storyId;

    const patch = asRecord(event.patch);

    if (patch !== undefined && patch.story_id === storyId) return true;

    return storyIdOfRecord(store, event.id) === storyId;
}

/** Did this event touch the artifact this job is about, rather than something else in the Story? */
function eventTouchesUnit(event: CommitEvent, unitRef: string): boolean {
    if (event.id === unitRef) return true;

    // A patch that NAMES the unit is about the unit too (an invalidation mark, a verdict line).
    return event.patch !== undefined && JSON.stringify(event.patch).includes(unitRef);
}

/**
 * S-2's "what changed since the last pass", as the journal states it: op + why, newest first.
 * `why` is the attribution every write already carries (P11, T-5), so this section costs no new
 * state — and a unit-touching change outranks an unrelated one, because E-3 wants the brief to
 * carry the context of THIS job, not the Story's diary.
 */
function renderChangeNotes(store: Store, storyId: string, unitRef: string | undefined, limit: number): string {
    if (limit <= 0) return '(trimmed for brief size — the journal holds the rest)';

    const direct: string[] = [];
    const elsewhere: string[] = [];

    for (
        let index = store.journal.length - 1;
        index >= 0 && direct.length + elsewhere.length < CHANGE_NOTE_SCAN;
        index -= 1
    ) {
        const event = store.journal[index];

        if (!eventBelongsToStory(store, event, storyId)) continue;

        const line = `- ${event.op} ${event.id}: ${event.attribution.why}`;

        if (unitRef !== undefined && eventTouchesUnit(event, unitRef)) {
            if (direct.length < limit) direct.push(line);
        } else if (elsewhere.length < limit) {
            elsewhere.push(line);
        }
    }

    // Both buckets were filled newest-first, so each is reversed: the unit-touching notes come first
    // (E-3 wants the context of THIS job ahead of the Story's diary) and each group then reads
    // FORWARD, which is how an agent reads "what changed". `slice` copies, so reversing is safe.
    const mine = direct.slice(0, limit);
    const rest = elsewhere.slice(0, Math.max(0, limit - mine.length));

    if (mine.length + rest.length === 0) return '(no recorded changes yet in this Story)';

    return mine.reverse().concat(rest.reverse()).join('\n');
}

/**
 * D-29: the selected-but-unabsorbed Ideas this Writer must carry. `absorbed_into` is what keeps
 * the brief self-limiting: once the prose has taken the Idea it stops being context for the next
 * run, so a long Story's brief does not accumulate decisions forever (E-3).
 */
function renderSelectedIdeas(store: Store, storyId: string, unitRef: string | undefined, fieldClip: number): string {
    const selected = store.ideas
        .list()
        .filter(
            (idea: Idea) =>
                idea.story_id === storyId &&
                idea.state === 'selected' &&
                (idea.absorbed_into === undefined || idea.absorbed_into === '') &&
                (idea.unit_ref === undefined ||
                    idea.unit_ref === '' ||
                    unitRef === undefined ||
                    idea.unit_ref === unitRef)
        )
        // Newest first, by minted id suffix: §4.17 has no ordering field and `rev` is the CAS
        // token, not a sequence. An id minted by hand may not parse, which sorts as 0 — stable,
        // and stable is what the brief_hash needs.
        .sort((left, right) => idSuffix(right.id) - idSuffix(left.id));

    if (selected.length === 0) return '(nothing selected-and-unwritten for this unit)';

    return selected
        .map((idea) => {
            const verification = idea.verification
                ? `verified: ${idea.verification.verdict}${
                      idea.verification.meets_guidelines ? '' : ' — BUT it does not meet the Author guidelines (D-31)'
                  }`
                : 'unverified';

            return `- ${idea.id} (${idea.kind}, by ${idea.author}, ${verification})\n${clip(idea.body, fieldClip)}${
                idea.selection_note ? `\n  the Author's note: ${clip(idea.selection_note, 300)}` : ''
            }`;
        })
        .join('\n');
}

const idSuffix = (id: string): number => {
    const parts = id.split('_');
    // `slice(-1)[0]` rather than `.at(-1)` — the package's tsconfig lib predates ES2022.
    const suffix = Number(parts.slice(-1)[0]);

    return Number.isFinite(suffix) ? suffix : 0;
};

// ---------------------------------------------------------------------------
// The specific job (S-2)
// ---------------------------------------------------------------------------

/**
 * The job sentence, per kind. Every one of them names the tool that reports the outcome,
 * because S-4's no-op rule is easier to obey when the obligation is stated inside the job
 * rather than only in the etiquette section.
 */
function jobStatement(item: WorkItem): string {
    switch (item.kind) {
        case 'write_unit':
            return 'Write the unit named above (you are the only thing that writes story artifacts — P10, D-17b). Deliver the contract, then report with `submitVerdict`.';
        case 'check_unit':
            return 'Judge the unit against the criteria above and report with `submitVerdict` (P4: does it deliver its contract?). Every failing criterion needs an evidence line (D-15).';
        case 'select':
            return 'Choose between the competing revisions below by applying the selection rules to the drafts side by side, then `selectRevision` on exactly one, or `requestMerge` when the right unit is made of parts (L-19), or `rejectAll` when none deserves it (L-18). The `selection_note` must name the rule you applied and what you preferred in each draft (L-17, T-2a).';
        case 'verify_findings':
            return 'Verify each finding listed below against the artifact: `verifyFinding` to confirm or dispute it, rewriting title/detail/evidence into one claim the Author can read in one pass and setting the cost it actually deserves (D-33, D-34, D-34a).';
        case 'verify_ideas':
            return 'Verify each Idea listed below: re-read the cited source or find a second one, then `verifyIdea` with the verdict, the evidence, and `meets_guidelines` answered separately from the fact-check (D-27, D-31). Where you cannot check it from here, `markUnverifiable` is the honest answer.';
        case 'merge':
            return 'Decide which parts of the competing revisions merge and hand the seam to the Writer with `requestMerge` — an Editor selects the parts and never composes the sentences (L-19).';
        case 'whole_story_check':
            return 'Judge the whole Story at the levels named above and report with `submitVerdict`. The chapter list and the Digest are your reading; the full prose of every chapter is not (E-1).';
        case 'directive_work':
            return 'Propagate the directive below: `createTask` for the work it implies, `raiseFinding` where it exposes a contradiction, and a report of what you touched (D-19).';
        default:
            return 'The Author asked for this specific edit and you hold the Author write rights for this run only: never write a locked artifact, and the web tools are not yours in this run (§8.6).';
    }
}

/** The refs a job carries, resolved out of the store — S-2's "the specific job" plus what it names. */
function renderJob(store: Store, item: WorkItem, fieldClip: number): string {
    const blocks: string[] = [jobStatement(item)];

    if (item.note) blocks.push(`The sweep's note on this job: ${clip(item.note, 600)}`);

    const tasks = (item.taskRefs ?? []).map((ref) => store.tasks.get(ref)).filter((task) => task !== undefined);

    if (tasks.length > 0) {
        // S-2: "the open tasks that job must clear" — the queue, not the transcript, holds the plan (D-11).
        blocks.push(
            `Tasks this job must clear (${tasks.length}):\n${tasks
                .map(
                    (task) =>
                        `- ${task.id} [${task.state}, ${task.owner_role ?? 'unowned'}, p${task.priority}${
                            task.criterion_ref ? `, ${task.criterion_ref}` : ''
                        }, ${task.attempts} attempt(s)]: ${clip(task.title, 300)}${task.detail ? `\n  ${clip(task.detail, fieldClip)}` : ''}`
                )
                .join('\n')}`
        );
    }

    const findings = (item.findingRefs ?? [])
        .map((ref) => store.findings.get(ref))
        .filter((finding) => finding !== undefined);

    if (findings.length > 0) {
        blocks.push(
            `Findings in front of you (${findings.length}):\n${findings
                .map(
                    (finding) =>
                        `- ${finding.id} [${finding.state}, cost ${finding.cost}, seen ${finding.seen_count}×, criterion ${
                            finding.criterion_ref
                        }]: ${clip(finding.title, 300)}\n  evidence: ${clip(finding.evidence, 600)}${
                            finding.detail ? `\n  detail: ${clip(finding.detail, fieldClip)}` : ''
                        }`
                )
                .join('\n')}`
        );
    }

    const ideas = (item.ideaRefs ?? []).map((ref) => store.ideas.get(ref)).filter((idea) => idea !== undefined);

    if (ideas.length > 0) {
        blocks.push(
            `Ideas in front of you (${ideas.length}):\n${ideas
                .map(
                    (idea) =>
                        `- ${idea.id} [${idea.state}, ${idea.kind}, by ${idea.author}]${
                            idea.sources.length > 0 ? ` (${idea.sources.length} source(s) cited)` : ''
                        }: ${clip(idea.body, fieldClip)}`
                )
                .join('\n')}`
        );
    }

    if (item.directiveRef) {
        const directive = store.directives.get(item.directiveRef);

        // D-19: a directive is a decision the loop must PROPAGATE, so its text is the job.
        blocks.push(
            directive === undefined
                ? `Directive ${item.directiveRef}: (no such record)`
                : `Directive ${item.directiveRef} [${directive.state}]: ${clip(directive.text, 1_000)}`
        );
    }

    return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Tool etiquette (short on purpose — T-13: a rule with a tool behind it needs one line)
// ---------------------------------------------------------------------------

function renderEtiquette(kind: RoleKind): string {
    return [
        `Every tool in §8 is registered on this session whatever your kind — ${permissionLine(kind)}. A call your kind may not make is REFUSED at the call, naming the rule (T-1a), so try rather than guess: a refusal is information, not a failure.`,
        "`listTools` lists the catalogue this session holds and `describeTool` gives one tool's exact shape (T-6c) — cheaper than guessing a field and being refused (T-11).",
        'Every mutating tool takes `expects: [{id, rev}]` and `why` (T-4, T-5). A rejected write returns the CURRENT record: re-read what it says now, re-apply your change against that, and send it again with the rev you were handed. Never force — concurrent crews are expected, not exceptional (T-4).',
        'Every tool result names the revision it was read at (T-8), so your next `expects` can be correct without a second read.',
        'If the Digest is not enough to judge, file a `digest_gap` finding (D-13) rather than reading the whole book — reading past this brief is the signal the Digest needs work (E-2).',
        'If this brief asks for something no tool can do, call `reportGap` naming the job, what you needed and what you did instead (T-12). Do not improvise a workaround the Author will read as a choice.',
        `End the run ONLY after reporting with one of: ${REPORT_TOOLS.join(', ')} (S-4). A run that reports nothing is a no-op turn counted against the Story — and a Writer run that wrote nothing and escalated nothing is a bug in its brief, not a cost.`,
        'Before you end, put anything you learned into the store: if it is not in the store it was not produced (P1, P3).',
        'Never `updateDigest` — the engine derives it (D-12a). Never lock, unlock or backtrack (D-1). Never touch `chapter_count` (D-3b).'
    ].join('\n- ');
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** A rendered brief: the text the model is given, plus the section headings it was built from. */
export interface AssembledBrief {
    text: string;
    /** The section headings, in render order — the assertion surface for "the brief is self-contained" (S-2). */
    sections: string[];
}

/** One assembled section; the three deferred ones are filled per trim step in {@link renderAll}. */
interface Part {
    heading: string;
    body: string;
}

/**
 * Assembles the brief for one Work Item out of the store alone (S-2). Pure: the same store
 * state and the same item produce byte-identical text, which is what `runs.brief_hash` (§4.13)
 * and D-12a's reconstructibility promise both depend on.
 *
 * Throws only when the Story row is missing — every other gap (no Digest, no Summary, no Goal,
 * no role prompt) is rendered INTO the brief as a stated absence, because a fresh context told
 * "there is no digest yet, file a digest_gap" behaves correctly, and one given a silent hole
 * invents a filler (T-6a's named failure mode).
 */
export function assembleBrief(store: Store, item: WorkItem, harness: ResolvedHarness): AssembledBrief {
    const story = store.stories.get(item.storyId);

    if (story === undefined) {
        throw new Error(
            `brief for work item ${item.id}: no story ${item.storyId} in the store — a run is scoped to exactly one Story (T-3)`
        );
    }

    const goal = goalFor(store, story);
    const digest = currentDigest(store, story);
    const levels = levelsFor(item, story.phase);
    const perChapter = item.unit?.kind === 'chapter' || (story.phase === 'chapters' && item.kind === 'check_unit');
    const criteriaPool = goal?.criteria ?? [];

    const parts: Part[] = [];

    // 1. The role prompt (S-2's first element): D-17a makes it the ONLY thing separating this
    //    run from every other kind holding the same tool catalogue (T-6a).
    const roleLines = [
        harness.role?.prompt ??
            '(no role prompt was found for this template — follow the job, the criteria and the permission line below, and treat the absence as a template defect to report, D-17a)'
    ];

    if (harness.warning) roleLines.push(`WARNING: ${harness.warning}`);
    if (harness.template?.done_definition) roleLines.push(`Done means: ${harness.template.done_definition}`);
    // D-17c: `selection_rules` is the Editor's brief in the Author's own words — and C-13 is
    // defined against it, so a checker grading C-13 needs it too (P12: without it the crew is
    // guessing at the Author's taste).
    if (harness.template?.selection_rules) {
        roleLines.push(
            `The Author's selection rules (D-17c, P12) — this is the taste you apply:\n${harness.template.selection_rules}`
        );
    }
    if (harness.template?.escalation_rule)
        roleLines.push(`Escalate rather than halt (P7): ${harness.template.escalation_rule}`);
    if ((harness.template?.delegation?.length ?? 0) > 0) {
        // D-17e: delegation stays inside THIS run — never a Work Item, never a crew row (S-7, T-2b).
        roleLines.push(
            `You may delegate inside this run to: ${harness.template?.delegation?.join(', ')} — a sub-context writes nothing you could not write yourself, and you remain the one that reports (D-17e, T-2b).`
        );
    }

    parts.push({
        heading: `ROLE — ${harness.roleName} (${harness.kind}) of ${harness.template?.name ?? item.templateRef}`,
        body: roleLines.join('\n\n')
    });

    // 2. The phase and the criteria for THAT phase, grouped by §5.2's levels (G-4, G-2).
    const phaseLines: string[] = [`Phase: ${story.phase}. ${LEVEL_QUESTIONS[levels[0]]}`];

    if (goal) {
        phaseLines.push(
            `Goal "${goal.title}": every HARD criterion must pass; at least ${goal.threshold_soft} soft criteria must pass (P6: pass/fail with a citation, never a score).`
        );
    } else {
        phaseLines.push('(no Goal row for this Story — the built-in criteria below are all it has, G-4)');
    }

    for (const level of levels) {
        const criteria = criteriaForLevel(criteriaPool, level, levels[0]);

        phaseLines.push(
            `## ${LEVEL_LABELS[level]}\n${criteria.length > 0 ? criteria.map(criterionLine).join('\n') : '(no criteria in this level)'}`
        );
    }

    if (perChapter) {
        const perChapterCriteria = criteriaPool.filter((criterion) => PER_CHAPTER.includes(criterion.id));

        if (perChapterCriteria.length > 0) {
            phaseLines.push(
                `## Per chapter (outside the levels, §5.2)\n${perChapterCriteria.map(criterionLine).join('\n')}`
            );
        }
    }

    parts.push({ heading: `PHASE AND GOAL CRITERIA — ${story.title}`, body: phaseLines.join('\n\n') });

    // 3. The Seed, verbatim and marked untouchable (P5, D-3b).
    parts.push({ heading: 'SEED — Author truth, read-only for you at every phase, forever', body: story.idea });

    // 4. The Digest (D-13: the brief IS Digest + artifact + criteria, so no run has to read the book).
    parts.push({
        heading: `DIGEST${digest ? ` rev ${digest.rev}` : ''}${digest?.stale ? ' — STALE' : ''} (derived by the engine, never a crew: D-12a)`,
        body: digest
            ? `${digest.body}${digest.stale ? '\n(This Digest is stale: a REVIEW is blocked until the engine refreshes it, D-14 — a fix is not.)' : ''}`
            : '(no Digest record yet — this is the first pass. If you need one to judge, file a `digest_gap` finding, D-13.)'
    });

    // 5. The artifact under review (E-1), narrowed by phase and by the unit this job is about.
    parts.push({ heading: `ARTIFACT UNDER REVIEW — ${artifactHeading(store, item, story)}`, body: '' });

    // 6. The specific job, with the tasks, findings, Ideas and directive it names (S-2).
    parts.push({ heading: 'THE JOB', body: '' });

    // 7. What changed since the last pass (S-2) — journal ops and their `why` (P11).
    parts.push({ heading: 'WHAT CHANGED SINCE THE LAST PASS', body: '' });

    // 8. The selected-but-unabsorbed Ideas for this unit (D-29).
    parts.push({ heading: 'SELECTED IDEAS THIS RUN MUST ABSORB (D-29 — selected, not yet written in)', body: '' });

    // 9. Tool etiquette: T-4 CAS and re-read, T-5 why, S-4's closing obligation, D-13/T-12 gaps.
    parts.push({ heading: 'TOOLS AND HOW TO END', body: renderEtiquette(harness.kind) });

    // 10. The competing drafts, for the two kinds only that may see them (D-21). Rendered last
    //     because it is the section the trim ladder exists for: N whole drafts is the only part
    //     of a brief that can outrun E-1 by itself.
    const showsRevisions = (item.kind === 'select' || item.kind === 'merge') && !!item.unit?.ref;

    return renderWithinBudget(parts, store, item, story, showsRevisions);
}

/** The heading names the unit so an agent cannot mistake which record it is judging. */
function artifactHeading(store: Store, item: WorkItem, story: Story): string {
    if (item.unit === undefined) {
        if (story.phase === 'summary') return 'the Summary draft (whole-Story job)';
        if (story.phase === 'plotlines') return 'the plotline set (whole-Story job)';

        return `the chapter set (${store.chapters.list().filter((chapter) => chapter.story_id === story.id).length} chapters)`;
    }

    switch (item.unit.kind) {
        case 'summary':
            return 'the Summary draft';
        case 'plotline': {
            const plotline = store.plotlines.get(item.unit.ref);

            return `plotline ${item.unit.ref}${plotline ? ` — ${plotline.heading ?? 'untitled'} (order ${plotline.order})` : ''}`;
        }
        default: {
            const chapter = store.chapters.get(item.unit.ref);

            return `chapter ${item.unit.ref}${chapter ? ` — ${chapter.title} (order ${chapter.order}, state ${chapter.state})` : ''}`;
        }
    }
}

/**
 * The artifact body, phase-narrowed so the brief stays roughly constant regardless of book
 * length (E-1): a chapter job gets ONE chapter's prose plus its contract, a plotlines job gets
 * the outline and no prose, and a whole-Story job gets the chapter list while the Digest carries
 * what each chapter is.
 */
function renderArtifact(store: Store, item: WorkItem, story: Story, fieldClip: number): string {
    const blocks: string[] = [];

    if (item.unit === undefined) {
        if (story.phase === 'summary') blocks.push(`Summary:\n${renderSummaryFields(store, story.id, fieldClip)}`);

        if (story.phase === 'plotlines' || story.phase === 'chapters') {
            const outline = store.plotlines
                .list()
                .filter((plotline) => plotline.story_id === story.id)
                .sort((left, right) => left.order - right.order);

            blocks.push(
                outline.length === 0
                    ? 'Plotlines: (none yet)'
                    : `Outline — order · heading · must_happen · must_change (the contracts; never the prose):\n${outline
                          .map(
                              (plotline) =>
                                  `- ${plotline.id} · ${plotline.order} · ${plotline.heading ?? 'untitled'}\n  must_happen: ${clip(
                                      asText(plotline.must_happen),
                                      Math.min(fieldClip, 500)
                                  )}\n  must_change: ${clip(asText(plotline.must_change), Math.min(fieldClip, 500))}`
                          )
                          .join('\n')}`
            );
        }

        if (story.phase === 'chapters') {
            const chapters = store.chapters
                .list()
                .filter((chapter: Chapter) => chapter.story_id === story.id)
                .sort((left, right) => left.order - right.order);

            // E-1: one line per chapter. The prose of every chapter in a whole-Story brief is
            // exactly the context rot P2 exists to prevent, re-imported through the front door.
            blocks.push(
                chapters.length === 0
                    ? 'Chapters: (none yet)'
                    : `Chapters — state · round · one line from the record (the Digest carries what happened):\n${chapters
                          .map(
                              (chapter) =>
                                  `- ${chapter.id} · ${chapter.order} · ${chapter.title} [${chapter.state}, round ${chapter.round}${
                                      chapter.current_revision
                                          ? `, selected ${chapter.current_revision}`
                                          : ', no selected revision'
                                  }]${chapter.summary ? ` — ${clip(chapter.summary, 200)}` : ''}`
                          )
                          .join('\n')}`
            );
        }

        blocks.push(`Summary sheet:\n${renderSummaryFields(store, story.id, fieldClip)}`);

        return blocks.join('\n\n');
    }

    if (item.unit.kind === 'summary') blocks.push(`Summary:\n${renderSummaryFields(store, story.id, fieldClip)}`);

    if (item.unit.kind === 'plotline') {
        const plotline = store.plotlines.get(item.unit.ref);

        blocks.push(
            plotline
                ? renderPlotline(plotline, fieldClip)
                : `Plotline ${item.unit.ref}: (no such record — file a finding if the queue named one that is gone)`
        );
    }

    if (item.unit.kind === 'chapter') {
        const chapter = store.chapters.get(item.unit.ref);

        if (chapter === undefined) {
            blocks.push(`Chapter ${item.unit.ref}: (no such record)`);
        } else {
            blocks.push(
                fieldBlock(
                    [
                        ['chapter_id', chapter.id],
                        ['title', chapter.title],
                        ['summary', chapter.summary],
                        ['order', chapter.order],
                        ['state', chapter.state],
                        ['round', chapter.round],
                        ['last_score', chapter.last_score],
                        [
                            'author_locked',
                            chapter.author_locked ? 'true — every agent proposes, never rewrites (P9)' : 'false'
                        ],
                        ['bar_override', chapter.bar_override],
                        ['plotline_ref', chapter.plotline_ref]
                    ],
                    fieldClip
                )
            );

            // P4/D-13: the contract this prose must deliver is put IN the brief rather than
            // expected — the loop's one question is unanswerable without it, and D-13 forbids
            // sending an agent to fetch the context it was supposed to be given.
            const plotline = chapter.plotline_ref ? store.plotlines.get(chapter.plotline_ref) : undefined;

            blocks.push(
                plotline
                    ? `The contract this chapter must deliver (P4):\n${renderPlotline(plotline, fieldClip)}`
                    : 'The contract this chapter must deliver: (no plotline bound — C-1 fails until one is)'
            );

            blocks.push(
                chapter.sections.length > 0
                    ? `Sections (D-7 addressing — edit one section, never retype the chapter):\n${renderSections(chapter.sections, fieldClip)}`
                    : `Full prose (no sections yet, D-7):\n${clip(chapterContent(chapter), fieldClip)}`
            );
        }
    }

    return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Budget enforcement (E-3) — trim the notes first, never the reading
// ---------------------------------------------------------------------------

interface RenderInput {
    notes: string;
    revisions: string;
    clip: number;
}

/**
 * Renders the section list under {@link BRIEF_CHAR_BUDGET} by walking {@link TRIM_LADDER}.
 * The sections that may NEVER be trimmed are the Seed, the Digest, the criteria and the
 * artifact (D-13, E-1): when the brief still does not fit after the last step it goes over
 * budget rather than dropping the criteria or the prose — E-0 forbids gating on a count, and a
 * run that was never told the criteria cannot grade against them.
 */
function renderWithinBudget(
    parts: Part[],
    store: Store,
    item: WorkItem,
    story: Story,
    showsRevisions: boolean
): AssembledBrief {
    for (const step of TRIM_LADDER) {
        const input: RenderInput = {
            notes: renderChangeNotes(store, item.storyId, item.unit?.ref, step.notes),
            revisions: showsRevisions ? renderCompetingRevisions(store, item.unit?.ref ?? '', step.clip) : '',
            clip: step.clip
        };

        const rendered = renderAll(parts, store, item, story, input);

        if (rendered.length <= BRIEF_CHAR_BUDGET) return assemble(rendered, input, showsRevisions);
    }

    // The last rung of the ladder, indexed rather than `.at(-1)` (pre-ES2022 lib): reaching it
    // means the brief is over budget on purpose — E-0 forbids dropping the reading for a number.
    const lastStep = TRIM_LADDER[TRIM_LADDER.length - 1];

    return assemble(
        renderAll(
            parts,
            store,
            item,
            story,
            {
                notes: renderChangeNotes(store, item.storyId, item.unit?.ref, 0),
                revisions: showsRevisions ? renderCompetingRevisions(store, item.unit?.ref ?? '', lastStep.clip) : '',
                clip: lastStep.clip
            },
            lastStep.clip
        ),
        {
            notes: '',
            revisions: showsRevisions ? renderCompetingRevisions(store, item.unit?.ref ?? '', lastStep.clip) : '',
            clip: lastStep.clip
        },
        showsRevisions
    );
}

/** Fills the deferred sections (they depend on the trim step) and renders the whole brief. */
function renderAll(
    parts: Part[],
    store: Store,
    item: WorkItem,
    story: Story,
    input: RenderInput,
    overrideClip?: number
): string {
    const clipFor = overrideClip ?? input.clip;

    const filled = parts.map((part) => {
        if (part.heading === 'THE JOB') return { ...part, body: renderJob(store, item, clipFor) };
        if (part.heading === 'WHAT CHANGED SINCE THE LAST PASS') return { ...part, body: input.notes };
        if (part.heading.startsWith('SELECTED IDEAS'))
            return { ...part, body: renderSelectedIdeas(store, item.storyId, item.unit?.ref, clipFor) };
        if (part.heading.startsWith('ARTIFACT UNDER REVIEW'))
            return { ...part, body: renderArtifact(store, item, story, clipFor) };

        return part;
    });

    let rendered = filled.map((part) => section(part.heading, part.body)).join('\n');

    if (input.revisions !== '') rendered += `\n${section(REVISIONS_HEADING, input.revisions)}`;

    return rendered;
}

/** The final text plus the headings that rendered (a trimmed section keeps its heading — the trim is visible, not silent). */
function assemble(text: string, input: RenderInput, showsRevisions: boolean): AssembledBrief {
    const sections = text
        .split('\n')
        .filter((line) => line.startsWith('# '))
        .map((line) => line.slice(2));

    if (showsRevisions && input.revisions !== '' && !sections.includes(REVISIONS_HEADING))
        sections.push(REVISIONS_HEADING);

    return { text, sections };
}

// ---------------------------------------------------------------------------
// The hash (§4.13 `brief_hash`)
// ---------------------------------------------------------------------------

/** sha256 of the assembled brief — the audit key the crew panel and U-8c read. */
export const hashBrief = (brief: string): string => createHash('sha256').update(brief, 'utf8').digest('hex');

/** Convenience: assemble and hash in one call, so the run row and the model get the SAME text. */
export function buildBrief(store: Store, item: WorkItem, harness: ResolvedHarness): AssembledBrief & { hash: string } {
    const assembled = assembleBrief(store, item, harness);

    return { ...assembled, hash: hashBrief(assembled.text) };
}
