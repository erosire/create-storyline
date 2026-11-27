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
import { isGroupManagedStory, phraseGroupsOf, phraseStructureSeatOf } from '../phrase';
import type { PhraseStructureInstructionSet } from '../phrase';
// D-33c/D-33d: the open-issue count the "Findings in front of you" bracket prints is the loop's OWN
// answer (`loop/records.ts:openIssueFindings`), the same one the Critic's gate, the Editor's approval
// gate, the dial sweep, `engine.approveFinding` and the approve-all route read — so the brief can
// never tell the crew a different number from the one the tool refusal will quote. `loop/records.ts`
// imports nothing from `run/`, so this adds no cycle.
import { openIssueFindings } from '../loop/records';
import { REPORT_TOOLS, reportToolsForStructureSeat } from './catalogue';
import { permissionLine, type ResolvedHarness } from './harness';
// The Seed Brief and Knowledge renderers are shared with the Phase-1 compiler (./phase1-prompt):
// the same record must read the same way in a tool run's brief and in a sampling prefix, or the
// two prompts would disagree about what the Author's Seed means (§3.3, §5).
import { acceptedSeedBrief, promptKnowledge, renderKnowledgeBlock, renderSeedBrief } from './phase1-prompt';
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

/**
 * The heading the phase-① Seed Brief rides under (§3.3). It is a named constant rather than an inline
 * literal because the seat-aware trim rung ({@link renderWithinBudget}) addresses the section BY
 * HEADING — the same way the deferred sections are filled in {@link renderAll} — and because
 * `run/brief.test.ts` pins the section's placement against it.
 */
export const SEED_BRIEF_HEADING = "SEED BRIEF (structured from the Author's Seed — derived, the Seed itself stays law, P5)";

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

/**
 * The Summary block an agent reads (§4.4). On a group-managed book the five `summaries` fields are the
 * MIRROR of the phrase groups (`phrase/revisions.ts:syncSummaryMirror`, R6), so they carry the Overview's
 * text — but a field name cannot say which GROUP a quote came from, and on such a book every Summary
 * defect is routed and closed by group id (`tools/reader.ts:raiseFinding` refuses an unscoped one, and
 * `phrase/findings.ts:findingGroupScope` closes it only once every named group has an answering
 * revision). A Reviewer can only copy what it can see, so the block prints the book's groups in the
 * SAME `key=id` shape the R3 refusal prints. A legacy (`summary_mode: 'sampling'`) book keeps this block
 * byte-identical: an absent `group_refs` still means "the whole Overview" there, and there are no rows.
 */
function renderSummaryFields(store: Store, story: Story, fieldClip: number): string {
    const summary = store.summaries.list().find((candidate) => candidate.story_id === story.id);

    if (summary === undefined) return '(no Summary record yet)';

    // Catalog order, key beside each id, so the pair the model copies is the pair the engine wrote.
    const groups = isGroupManagedStory(story) ? phraseGroupsOf(store, story.id) : [];
    const groupField: [string, unknown][] =
        groups.length === 0
            ? []
            : [
                  [
                      'phrase_groups',
                      groups.map((group) => `${group.key}=${group.id}`).join(', ') +
                          ' — a defect on this Summary names in group_refs the group or groups it is about (R3)'
                  ]
              ];

    return fieldBlock(
        [
            ['summary_id', summary.id],
            ...groupField,
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
function renderRevision(revision: Revision, fieldClip: number): string {
    const verdicts = revision.verdict_refs.length > 0 ? revision.verdict_refs.join(', ') : 'none';
    const body = typeof revision.body === 'string' ? revision.body : JSON.stringify(revision.body ?? '');

    // T-7: bounded in the brief too — an Editor reads the drafts it is choosing between,
    // not the whole book around them (E-1).
    return [`revision_id=${revision.id} · state=${revision.state} · verdicts: ${verdicts}`, clip(body, fieldClip)].join(
        '\n'
    );
}

function renderCompetingRevisions(store: Store, unitRef: string, fieldClip: number): string {
    if (!unitRef) return '';

    const competing = store.revisions
        .list()
        .filter(
            (revision: Revision) =>
                revision.unit_ref === unitRef &&
                // §4.15: a draft is reviewable once its Writer run closed (`drafted`); `competing`
                // is the same meaning for rows written before the pending/drafted lifecycle.
                (revision.state === 'drafted' || revision.state === 'competing')
        )
        // §4.15 has no ordering field for drafts; the id is the only stable one, and a brief
        // that ordered them differently each assembly would make "which draft is 1" meaningless.
        .sort((left, right) => left.id.localeCompare(right.id));

    if (competing.length === 0) return '(no competing revisions for this unit)';

    return competing.map((revision) => renderRevision(revision, fieldClip)).join('\n\n');
}

/**
 * The drafts a job may see. A Critic review names ONE sample (`revisionRef`) because D-21 keeps
 * the competing drafts to the Editor and the Author; `select`/`merge` (and only those) see the
 * whole set, which is the set they are choosing between.
 */
function renderRevisionsForItem(store: Store, item: WorkItem, fieldClip: number): string {
    if (item.revisionRef !== undefined && item.revisionRef.length > 0) {
        const revision = store.revisions.get(item.revisionRef);

        return revision === undefined
            ? `(revision ${item.revisionRef} is gone — the sample was chosen or deleted)`
            : renderRevision(revision, fieldClip);
    }

    return renderCompetingRevisions(store, item.unit?.ref ?? '', fieldClip);
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
 * CS-VERDICT-1 — where a phase-① Reviewer is told to FILE THE VERDICT.
 *
 * WHY THE UNIT COMES FIRST: C-14 (and every `summary`-level criterion) is graded against the Summary
 * record — `criteria/engine.ts:scopeTargets` returns `storySummary(store, storyId).id`, and
 * `aggregateJudgeWithTargets` reads a verdict only when its `target_ref` is one of those ids (which
 * is what printed `summary_17: no verdict yet` on a book whose twenty Critic passes had all filed
 * against the draft). So the Summary-targeted line is the one the Goal reads, and a pass that files
 * ONLY at the draft is judged on borrowed evidence: the engine now accepts a verdict against the
 * draft the Summary row currently carries as Summary evidence (criteria/engine.ts
 * :summaryDraftEvidenceRefs), but that fallback exists for books written before this wording existed
 * — a fresh pass is still asked for its own Summary-targeted line.
 *
 * WHY THE DRAFT REFERENCE STAYS: §6.2a/D-21 file one verdict per revision, and U-13's side-by-side
 * panel needs a verdict on THIS draft. So the review owes BOTH lines, about the same text, and the
 * findings stay aimed at the unit with the draft named in `related_refs` (records.ts
 * :findingRevisionScope is what files them under the right Overview).
 *
 * The refs come from the item: `item.unit.ref` (the deep-review candidate carries
 * `{ kind: 'summary', ref: selected.unit_ref }`, `loop/work.ts:1169`) and `item.revisionRef` (the
 * selected draft, `loop/work.ts:1166`). When a job carries neither, the wording points at the
 * ARTIFACT UNDER REVIEW heading rather than inventing an id (S-2's stated absence over a silent
 * hole, T-6a).
 */
/**
 * Is this `check_unit` critic judging a SUMMARY? The item's unit is the artifact signal, not
 * `story.phase`: a phase-① Summary deep review can run while the Story has advanced, and a
 * chapter-contract review is dispatched with NO unit (`loop/work.ts`, the chapter lane). Using
 * `story.phase` alone put the prose banner on a Summary review in a later-phase Story.
 */
const isSummaryCriticReview = (item: WorkItem, story: Story): boolean =>
    // The unit is the direct signal. A defensive no-unit item in the Summary phase is still a
    // Summary review: the job line must say "read the unit above", not invent a Story id the
    // phase-① seat never had. A chapter-contract review in phase ② has no unit either, but its
    // Story phase is `plotlines`, so the fallback cannot mislabel it.
    item.unit?.kind === 'summary' || (item.unit === undefined && story.phase === 'summary');

const criticReviewTargetPhrase = (item: WorkItem, story: Story): { unit: string; revision?: string } => {
    // A chapter-contract review is a WHOLE-STORY judgement (the chapter set against the phrase
    // seed), and its dispatch site names no unit (`loop/work.ts`, `check_unit` at the chapter
    // lane). The Summary wording — "the Summary unit this job names" — is simply false there.
    if (!isSummaryCriticReview(item, story)) {
        return { unit: `\`target_ref\` \`${story.id}\`` };
    }

    return {
        unit:
            item.unit?.ref === undefined
                ? 'the Summary unit this job names under ARTIFACT UNDER REVIEW above'
                : `\`target_ref\` \`${item.unit.ref}\``,
        revision:
            item.revisionRef === undefined || item.revisionRef === ''
                ? undefined
                : `\`target_ref\` \`${item.revisionRef}\``
    };
};

/**
 * The job sentence's verdict clause: both filings, in the order that matters, and what each one is
 * FOR. Built here rather than written inline because the sweep note this job carries is clipped at
 * 600 characters (`renderJob`) — this sentence is the authoritative wording, and the note only
 * repeats it inside the window that survives.
 *
 * ONE CALL, TWO LINES (2026-11-26). The clause used to read "Report the verdict TWICE with
 * `submitVerdict`", which a model acts on as TWO tool calls — and each extra call is a round-trip the
 * owner's complaint is about. The D-21/U-13 obligation is unchanged (the Summary line the Goal reads
 * AND the draft line the crew panel reads), but it is now stated as what the pass's single terminal
 * report CONTAINS, not as an instruction to call the tool twice. The parameter names of that report
 * are still being finalised in `tools/reader.ts`, so the shape is described in words; `target_ref`
 * stays named because CS-VERDICT-1 is precisely about WHICH id each line is aimed at (see the helper
 * above), and dropping it would re-open the shipped failure this clause exists for.
 */
const criticReviewVerdictInstruction = (item: WorkItem, story: Story): string => {
    const targets = criticReviewTargetPhrase(item, story);

    // Phase ② has no per-draft line: the chapter contracts are judged as a set, and the command
    // job note names `story.id` for both the findings and the goal verdict. Saying "the Summary
    // unit" or "the draft this brief carries" here was the phase-mismatch the banner now also
    // blocks; this branch is the durable, job-line half of the rule.
    if (!isSummaryCriticReview(item, story)) {
        const judged = story.phase === 'plotlines' ? 'chapter contracts are' : 'prose is';

        return `Put the goal verdict in the pass\u2019s ONE terminal report, at ${targets.unit} — the whole Story the ${judged} graded against. The findings ride in that same report as \`findings[]\`; there is no draft line to file.`;
    }

    if (targets.revision === undefined) {
        return (
            `Put the goal verdict in the pass\u2019s ONE terminal report, at ${targets.unit}` +
            (item.unit?.ref === undefined
                ? ' — this job carries no artifact ref of its own, so read the id from that heading'
                : ' — the record the Goal\u2019s criteria are graded against') +
            '. A verdict filed at the draft alone is display evidence for the crew panel, not the line the Goal is measured on.'
        );
    }

    return (
        'Put BOTH verdict lines in the pass\u2019s ONE terminal report, about the same text and reaching the same answer: ' +
        `first at ${targets.unit} — the Summary unit the Goal\u2019s criteria are graded against, and the line the Goal actually reads — ` +
        `then at ${targets.revision}, the draft this brief carries, which is the per-draft record the crew panel and the revision rail read (D-21, U-13). ` +
        'Those two lines are one call, the last one this pass makes — the draft line never replaces the Summary line, and a Goal verdict filed only against a draft is graded on borrowed evidence.'
    );
};

/**
 * The job sentence, per kind. Every one of them names the tool that reports the outcome,
 * because S-4's no-op rule is easier to obey when the obligation is stated inside the job
 * rather than only in the etiquette section.
 */
function jobStatement(store: Store, item: WorkItem): string {
    // The job line is phase-specific because the same `check_unit` critic kind serves the Summary
    // and the chapter contracts. The Summary branch below is the phase-① contract; the plotlines
    // branch is the contract-chain job. `store` is read once for the phase, and a missing Story
    // (unreachable through `assembleBrief`) falls back to the Summary wording rather than throwing
    // a second time.
    const story = store.stories.get(item.storyId);
    switch (item.kind) {
        case 'structure_seed':
            // THE STRUCTURE SEAT IS THE PHRASE'S, NOT THE KIND'S (R2, R7). ONE kind serves both phrases:
            // `loop/work.ts:1935` arms Phrase ①'s Seed pass and `loop/work.ts:1614` arms Phrase ②'s
            // chapter pass, both as `structure_seed`, because the KIND is "an Editor derives a brief
            // before anything is drafted" and that is true of both. The sentence therefore comes from the
            // controller whose claim family the job id belongs to
            // (`phrase/controller.ts:phraseStructureSeatOf`), not from the kind. Until that lookup
            // existed, the Phrase ② seat was handed Phrase ①'s `structureSeed` / Seed-Brief /
            // `research_questions` sentence — the brief the Owner read as "the Editor messed up the
            // compiled Seed". Phrase ①'s copy now lives in `controllers/summary.ts` (unchanged bytes,
            // §3.3 / §6.4 gate 1 / D-51) and the chapter seat's in `controllers/plotlines.ts`.
            return phraseStructureSeatOf(item.id).job({ store, story });
        case 'research':
            // §3.2 / §6.4 gate 2: the Researcher's product is Knowledge, with sources. D-51: the job
            // names the Editor's questions, and "nothing needs research" is an answer the loop accepts —
            // but only when it is REPORTED, because a silent run is a no-op turn against the Story (S-4).
            return 'Research what this Story depends on — the period, place, technology, people and facts a draft would otherwise have to guess — and record each claim with `writeKnowledge`: one entry per claim, an importance level, and at least one source you actually read (T-10). Work the questions this job names, in order, and stop when they are answered: an unasked topic is not your job, and `readKnowledge` first so a fact the book already holds is not researched twice. Do not write story artifacts (P10) and do not raise findings about prose: when a fact cannot be established from here, file a task or escalate with `requestAuthor` rather than inventing it (P7). Dedupe is automatic (a repeat report bumps `seen_count`), so report the fact once; `retireKnowledge` marks an entry that is no longer true instead of deleting it. When NOTHING here needs an outside lookup — the Seed states every fact the story depends on, or the knowledge you just read already answers the questions — close the pass with `reportNoResearch` and one line saying why. That is a report, not a failure: it writes nothing, it ends the run, and the loop moves straight to sampling (D-51).';
        case 'sample_unit':
            // Unreachable through the assembled brief (a sampling run has no tools and gets the
            // compiled prompt instead), stated anyway so the kind is never described as an edit.
            return 'This job is the single-turn sampling mode: the compiled prompt is your whole memory, you have no tools, and your answer is one JSON object matching the SummarySample schema (§4.3, §2 decision 3). Nothing in the book is written by this run — the engine persists the sample.';
        case 'screen_samples':
            return 'This job is the single-turn screening mode: judge the one draft the compiled prompt carries, with no tools, and answer with one JSON object matching the IssueList schema — critical and high issues only (§4.3, §6.4 step 4). Report defects, never Proposals, and return an empty list when the draft holds.';
        // SUMMARY PHRASE (R2/R3/R5). Like the two kinds above, these are unreachable through the
        // assembled brief — a group job is a `toolMode: 'none'` run whose WHOLE memory is the compiled
        // prompt (`phase1-prompt.ts:compileGroupDraftPrompt`/`compileGroupReviewPrompt`). They are
        // stated anyway for the reason `sample_unit` is: a kind the brief cannot describe is a kind a
        // reader of the code (or of a transcript) will otherwise assume is an edit run.
        case 'draft_groups':
            return 'This job writes phrase GROUPS, not a whole Summary: the groups the compiled prompt names, each with its own revision line, and nothing else (R2). You have no tools and one turn; your answer is one JSON object matching the GroupDraft schema, with one entry per named group. The engine installs an answer for all the named groups or for none, and it archives what each replaced — there is no competing draft and nobody to choose between them (R5).';
        case 'review_groups':
            return 'This job reviews the INSTALLED Overview — the five groups as the Summary now holds them, not a candidate among siblings. You have no tools and one turn; your answer is one JSON object matching the GroupReview schema, critical and high issues only, and every issue names the `group_refs` it is about (R3). Report defects, never Proposals, and return an empty list when the Overview holds.';
        // READER SCORING (D-65): the one kind whose product is a number the Author reads and the loop
        // ignores. Unreachable through the assembled brief like the three kinds above (a `toolMode:
        // 'none'` run gets the compiled prompt), and stated for the same reason — a job the brief cannot
        // describe is a job a reader of a transcript assumes files findings. The one-line form is on
        // purpose: the sentence an Author reads must not promise work the pass is forbidden to do.
        case 'score_sections':
            return 'This job scores each section of the installed Overview 0–100 for internal logic, consistency with the other sections and plausibility, with one rationale and one quoted line per section. You have no tools and one turn; your answer is one JSON object matching the SectionScores schema, naming every group exactly once (§D-65). You file no finding, open no task and submit no verdict: the number is a progress surface for the Author, never a decision the loop takes (P6).';
        // PHRASE GROUP LOCK (R-lock): the one kind whose product is a flag on a row that already exists.
        // Unreachable through the assembled brief like the four kinds above (a `toolMode: 'none'` run gets
        // the compiled prompt, `run/phase1-prompt.ts:compileGroupLockPrompt`), and stated for the same
        // reason: the sentence has to say what a `true` COSTS, or a model answers the easy way.
        case 'group_lock':
            return 'This job judges ONE section of the reviewed Overview: is it FINISHED? You have no tools and exactly one turn; your answer is one JSON object matching the GroupLockDecision schema — the `group_ref` the CANDIDATE SECTION names, `lock: true` only when the evidence in the prompt supports BOTH no remaining issue and no missing major improvement, and a non-blank `rationale` naming what you weighed (§R-lock). Weigh the Reader\u2019s rationale, never its number alone: no score locks a section. A `true` makes that text fixed for the whole crew and stops every claim against it being work, and only the Author can undo it; a `false` leaves it to the loop, which is the ordinary answer.';
        case 'write_unit':
            // T3 — the Writer's licence, stated where the tool-using Writer reads its job. The sampler's
            // copy of the same rule is engine-owned text in `run/phase1-prompt.ts:SEED_CONTRACT_NOTE`; this
            // is the durable half for a run that holds the tool catalogue, and it survives an Author
            // rewriting the Writer template's role prompt.
            return item.unit?.kind === 'summary'
                ? 'Write ONE Summary from the Author requirements and the structured Seed above: fill every §4.2 block — premise, promise, theme, tone, ending, world_rules — in that order, keeping the Seed untouched (P5). The Seed and its Brief commit what they STATE and are silent about everything else on purpose: where they are silent, or name a question in `open_questions`, supply the specific yourself — a place, a consequence, a stake, a custom — as long as it contradicts nothing they state. Invention is the job here, not a defect you are penalised for, and no reviewer may ask the Summary for foreshadowing or detail neither the Seed nor your own draft promised. What you must not do is contradict the brief, or drop a commitment it states explicitly. When the job names findings or tasks, correct exactly those defects while keeping all six blocks complete. Report the draft with `submitVerdict` (you are the only thing that writes story artifacts — P10, D-17b).'
                : 'Write the unit named above (you are the only thing that writes story artifacts — P10, D-17b). Deliver the contract, then report with `submitVerdict`.';
        case 'check_unit':
            // Phase ①'s per-draft review is a CRITIC pass (D-30), not a consistency check: the
            // critic compares the sample to the Seed the Author wrote and files what CONTRADICTS it or
            // breaks a commitment it states explicitly. The role prompt carries the angle; this names
            // the obligation and its stopping rule — the pass is bounded, not an open-ended hunt for
            // polish.
            //
            // T3 — the cost ladder used to read "`major` means a promised element is broken or
            // missing", and the two Author screenshots came straight out of the `missing` half: a refuge
            // with no earlier planting, and a stake the Seed never stated. Both are inventions the
            // Writer is allowed. This is the durable, ENGINE-OWNED half of the rule (the Author may
            // rewrite the four angle templates, `run/brief.ts:CRITIC_REVIEW_MODE` and this line are not
            // editable), so it states the admissibility test and the quote requirement in both places
            // the tool-using Reviewer is guaranteed to read.
            // Phase ②'s chapter-contract twin. The Summary job sentence above is false here in
            // three ways — the artifact is not the Summary, the criteria are not C-14/C-15, and the
            // "prose is a proposal" calibration is phase ①'s — so the chapter lane gets its own
            // sentence rather than a paragraph of caveats laid over the Summary one.
            if (item.roleName === 'critic' && !(story === undefined || isSummaryCriticReview(item, story))) {
                if (story?.phase === 'plotlines') {
                    return (
                        'Read the chapter contracts named above against the phrase seed. The contracts are the artifact: every payoff has a setup in an earlier chapter, every setup is collected in a later one, a chapter that changes nothing leaves the book flat, and state, knowledge and relationship must hold across the chapter boundaries. A contract may be sparse and still correct; judge it as a contract, not as a scene nobody wrote, and never file a note because you would have staged the chapter differently — phase \u2462 writes the sentences. Find the critical and major issues you can QUOTE — a contradiction of the phrase seed, critical Knowledge, or a contract\u2019s own setups and payoffs, or a commitment the seed states centrally that the chapter set lacks — and put them in the `findings[]` array of the ONE terminal `submitVerdict`, each at `target_ref` `' +
                    story.id +
                    '`: `detail` (what is wrong and where), `criterion`, the quoted passage, and the evidence line. Cite `C-7`, `C-8` or `C-9` for a chapter contract, `C-0` through `C-6` for the plotline contract the chapter fails, or `seed` for a direct breach of the phrase seed; never cite `C-14` or `C-15` here. Name in `group_refs` EVERY chapter the defect crosses, copied from the ids printed above; a defect crossing chapters is ONE finding naming both, never one per chapter. Quote the chapter you name in `location`; do not name a chapter you did not read. A minor note is optional and must not keep you searching; an empty pass is valid. ' +
                    criticReviewVerdictInstruction(item, story) +
                    ' Do not propose Ideas. The thread is over the moment the ONE `submitVerdict` fires; nothing is filed after it.'
                    );
                }

                // Phase ③'s prose twin (defensive: the current phase-③ lane uses readers). It must
                // not inherit the Summary job sentence — C-10…C-13 and prose quality ARE reviewable
                // here, and the Summary-phase "prose is a proposal" rule is explicitly overridden.
                return (
                    'Read the chapter prose named above against its contract and the criteria. C-10, C-11, C-12 and C-13 apply; word choice, sentence shape, grammar and register ARE reviewable here, and the Summary-phase rule that prose is never an Issue does not apply to this pass. Every finding must quote the line it is about. Put the critical and major issues in the `findings[]` array of the ONE terminal `submitVerdict`, each at `target_ref` `' +
                    story!.id +
                    '`: `detail` (what is wrong and where), `criterion`, the quoted passage and the evidence line. Name in `group_refs` every chapter or Story group the defect crosses; a defect crossing chapters is ONE finding. Quote the group you name in `location`; do not name a group you did not read. A minor note is optional; an empty pass is valid. ' +
                    criticReviewVerdictInstruction(item, story!) +
                    ' Do not propose Ideas. The thread is over the moment the ONE `submitVerdict` fires; nothing is filed after it.'
                );
            }

            return item.roleName === 'critic'
                ? 'Read the Summary named above (its phrase groups where the book is written group by group, its draft fields where it is still sampled whole; the text is carried in this brief — call `readSummary` only if the brief does not carry it or says it was clipped) against the Seed. Use tools to check a specific doubt, not to survey the book; for a factual point one citable source is enough. Find the issues that matter and put them in the `findings[]` array of the one terminal `submitVerdict` — `detail` (what is wrong and where), the criterion, the quoted passage, the evidence line, and the cost you actually believe. On a book written group by group a Summary defect also names its SCOPE: copy the `phrase_groups` pairs the Summary block above prints into `group_refs` — one group when the fault sits inside one text, several when the complaint IS the gap between them, all five when the Overview itself is what is wrong. An unscoped Summary finding is refused on such a book, and a scoped one closes only once every group it names has been revised (R3). Report critical and major issues first: `critical` means the Summary contradicts itself, the Seed, or critical Knowledge (a story-logic inconsistency); `major` means a commitment the Seed or the Summary states EXPLICITLY that the draft breaks; `minor` is a note and must not keep you searching, and `taste` is not an Issue’s word at all — a preference is a Proposal. The Seed is general and is not an outline: where it is silent, or names a question in `open_questions`, the Writer may invent any specific that does not contradict it. So an added detail, a Seed question left open, stakes or consequences the Seed never stated, and setup a Summary did not promise are NOT defects and never a C-14 finding — a Summary is not required to foreshadow its own ending or to spell out what the Seed left open. Admissible proof is a quotation: file what you can quote the draft contradicting, and nothing that rests on an absence alone. An absence is never an issue, but it may be a PROPOSAL: where the draft contradicts nothing and you can still name a change that would genuinely make the book better, put it in that same `findings[]` as `kind: proposal` — a title that PROPOSES the change instead of accusing the text of missing something, `detail` saying what to change and why it is worth a Writer pass, and `evidence` quoting the passage it would improve. Say `kind: proposal` on purpose: an unmarked finding is a defect claim, and an Editor disputes a defect whose whole case is an absence, while a marked Proposal is weighed on whether the story the Seed promises is better for it. A Summary is a set of facts and consequences, not prose — word choice, sentence shape, grammar and register are a PROPOSAL at this phase — `kind: proposal` at cost `taste` or `minor`, never an Issue — because phase \u2462 writes the sentences and a round restarted over a rewording has no best answer to converge on. ' +
                      // CS-VERDICT-1: the verdict clause names the Summary ref (see the helper). It is
                      // built here rather than written inline because the note this job carries is
                      // clipped at 600 characters — this sentence is the authoritative wording.
                      // `assembleBrief` has already thrown for a missing Story; this is the
                      // direct-`renderJob` fallback, where the Summary wording is the only one
                      // available and the caller has no phase to select.
                      criticReviewVerdictInstruction(item, story!) +
                      // T5: the Ideas prohibition stays (a review pass is not the Idea tray, D-26/D-30),
                      // but the pass now has one legitimate outlet for a proposal, so the sentence names
                      // it instead of leaving "report defects" to read as "silence is the only verdict".
                      // D-33c's SEQUENCING lives in this same sentence, because this is the line a
                      // tool-using Critic actually acts on — restated 2026-11-26 to match what the tool
                      // now DOES: the mirror rule ("an issue and a proposal never share a pass") is gone
                      // with `tools/reader.ts:dismissedProposal`, and a proposal over an open issue is
                      // DISMISSED (no row, no work, no retry), not refused-with-an-invitation. The
                      // pass-pairing wording and "bring it in a pass that has none left" are therefore
                      // retired from here as well: they promised a second call that the rule no longer
                      // offers, which is one of the round-trips the owner's complaint is about.
                      ' This is a REVIEW PASS: report defects and file genuine Proposals as `kind: proposal` findings — do not propose Ideas. ISSUES COME FIRST (D-33c): while any issue on this Story is unresolved (only `unconfirmed`, `confirmed` and `approved` hold one open; a row marked `disputed`, `fixed` or `discarded` releases it) a `kind: proposal` claim is DISMISSED on the call — no row, no work armed, and no retry to spend — while an issue is filable whatever else is open. The LIVE STATE line at the top of this brief is that count, so do not spend a call learning it: with an issue open, keep the improvement to yourself and file the defect. CONCLUDE, DO NOT MINE: file the issues you are certain of and stop — a defect you had to dig for is not worth filing, and nit-picking is forbidden. The pass ends with ONE terminal `submitVerdict` report carrying both verdict lines and every finding you are sure of, and the thread is over the moment that call fires; a pass that files nothing and reports that the text holds is a valid outcome, not a wasted run.'
                : 'Judge the unit against the criteria above and report with `submitVerdict` (P4: does it deliver its contract?). Every failing criterion needs an evidence line (D-15).';
        case 'select':
            return item.unit?.kind === 'summary'
                ? 'Choose exactly ONE of the complete Summaries below, applying the selection rules side by side, and call `selectRevision` on it. The other drafts are kept as discarded history, never deleted. Phase ① does not merge: the next round, if one is needed, writes three complete drafts from the winner. Use `rejectAll` only when no draft deserves the Author. The `selection_note` must name the rule you applied and what you preferred in each draft (L-17, T-2a).'
                : 'Choose between the competing revisions below by applying the selection rules to the drafts side by side, then `selectRevision` on exactly one, or `requestMerge` when the right unit is made of parts (L-19), or `rejectAll` when none deserves it (L-18). The `selection_note` must name the rule you applied and what you preferred in each draft (L-17, T-2a).';
        case 'verify_findings':
            // T3 adds the ADMISSIBILITY test, which the old wording had no room for: the Editor used to
            // be asked only "is the defect real", and an absence is factually real forever — so `the
            // Summary never says what is lost` was confirmable on its own and bought the round a Writer
            // pass. The test is now stated positively (quote a commitment, show it broken), and the
            // phase-① blocking line is corrected: `minor` is authorised work whenever the Story's
            // `auto_approve` dial covers it, which is the DEFAULT (`shared/types.ts:
            // DEFAULT_AUTO_APPROVE_COSTS` → `loop/records.ts:summaryBlockingCost`). The old sentence
            // claimed minor notes "never block", which is simply not the shipped dial; the dial itself is
            // untouched, only the description of it.
            //
            // T5 adds the SECOND evaluation mode beside that admissibility test. A row marked
            // `proposal` is a proposal the Seed never had to promise, and the absence rule above is
            // precisely what used to reject the Critic's best suggestions without anyone weighing them:
            // the clause below scopes that rule to issues and sends a Proposal to a merit check — is
            // the change worth a Writer pass, and does it contradict the installed text — which is the
            // behaviour fix the Author asked for. Plain issues keep the rule unchanged.
            return 'A single finding is in front of you. Run ONE quick validity check: read its `detail`, `evidence` and the passage it quotes, then call `verifyFinding` with `confirmed` when the defect is real or `disputed` when it is not. Put the reason in `why`; add `evidence` only when the check itself shows something the Critic did not. ADMISSIBILITY comes before accuracy: a defect is real only when the finding quotes a commitment and shows the artifact breaking it — a contradiction of the Seed, of critical Knowledge, or of the artifact\u2019s own stated promise. The Seed is general and is not an outline, and the Writer may invent any detail the Seed does not rule out, so a claim whose whole case is an ABSENCE — a detail the Seed never stated, a field the Seed leaves silent or marks in `open_questions`, stakes or consequences the Seed left open, setup a Summary did not promise — is an INVALID finding however true the absence is: `dispute` it and name the silence as the reason, rather than confirming that something is missing. A finding marked `proposal` in its bracket is the one claim this test does NOT judge: the Critic is proposing a change the Seed never had to promise, not reporting a defect, so the absence rule does not apply to it. Weigh it on merit — `confirm` it when the change genuinely strengthens the story the Seed promises and is worth a Writer pass, `dispute` it when it is not worth the pass or would contradict the installed text, and NEVER dispute it merely because the Seed never promised it. Keep the Critic’s title, detail and cost unless they are clearly wrong — the Critic already supplied the reference, so do not re-investigate the book or rewrite the finding. On a group-managed book the groups a Summary finding names are the scope its repair is routed and closed by (R3): when the evidence quotes one group and the finding names five, dispute the scope rather than confirming it. When it is valid, call `approveFinding` with decision `auto` in the same run so the Story\u2019s dial authorises the work and the Critic can confirm it; a `disputed` finding needs no approval, and a finding whose cost the dial does not cover stays confirmed for the Author\u2019s own tap. This thread carries exactly one finding, so be fast and decisive. In phase \u2460, `critical` is a story-logic contradiction — of the Summary, of the Seed, or of critical Knowledge — and `major` is a commitment the Seed or the Summary states explicitly that the draft breaks. a `taste` row — which by rule is a Proposal, never an Issue — never blocks a Summary round, because the prose it would choose between is not written until phase \u2462; `minor` blocks exactly when this Story\u2019s `auto_approve` dial covers `minor`, which it does by default (D-35). So approve the costs the dial covers, and let the rest stay confirmed for the Author. ISSUES COME FIRST, and they gate the approval as well as the verdict (D-33d): while any issue on this Story is unresolved — only `unconfirmed`, `confirmed` and `approved` hold one open, and one you marked `disputed` releases it — `approveFinding` REFUSES a row marked `proposal`, whatever the dial says. So work the issues before anything else: settle this proposal with `verifyFinding` (a proposal is confirmed or disputed on merit, never on an approval), and if it cannot be approved yet leave it `confirmed` — it is not lost, and the pass that has no issue left approves it. Discarding a proposal is always allowed, because declining a change is not an approval. An ISSUE row is never held by this rule: the defects that unlock the proposals are exactly the work the loop must not stop taking.';
        case 'confirm_finding':
            // T3 — the same test on the Critic's own second look. Without it the confirmation pass
            // re-approved what the Editor had already waved through, because "the Summary really does
            // not mention X" survives any amount of independent checking.
            return 'The Editor has approved the finding listed below. Do your OWN independent check: read the cited passage and the claim, and decide whether the defect is real. An absence is not a defect: the Seed is general rather than an outline, the Writer may invent any detail the Seed does not contradict, so a claim that rests only on something the Seed never said — a detail, a stake, a consequence, an earlier planting — is not a defect however true the silence is. Call `confirmFinding` with `confirm` when it holds (this is what lets the Writer spend a round on it) or `dispute` when it does not (the fix task is withdrawn and the finding is recorded as disputed); `dispute` an omission-only claim on that ground, and `confirm` only a finding that quotes a commitment and shows the draft breaking it. Do not rewrite the finding and do not look for new defects — this thread exists to confirm or reject exactly one already-approved claim.';
        case 'verify_ideas':
            return 'Verify each Idea listed below: re-read the cited source or find a second one, then `verifyIdea` with the verdict, the evidence, and `meets_guidelines` answered separately from the fact-check (D-27, D-31). Where you cannot check it from here, `markUnverifiable` is the honest answer.';
        case 'merge':
            return 'Decide which parts of the competing revisions merge and hand the seam to the Writer with `requestMerge` — an Editor selects the parts and never composes the sentences (L-19).';
        case 'whole_story_check':
            return 'Judge the whole Story at the levels named above and report with `submitVerdict`. The chapter list and the Digest are your reading; the full prose of every chapter is not (E-1).';
        case 'directive_work':
            return 'You are the Editor, and the Author talks only to you: read the directive below, then set the work it implies with `createTask` (name the affected artifact ref in `detail`, pick the employee kind in `owner_role`, and give it a priority). The server checks the queue and opens a fresh thread for each task, so your product is the queue — not the prose (P10, L-19). `raiseFinding` where the directive exposes a contradiction, and a report of what you touched (D-19).';
        default:
            return 'The Author asked for this specific edit and you hold the Author write rights for this run only: never write a locked artifact, and the web tools are not yours in this run (§8.6).';
    }
}

/** The refs a job carries, resolved out of the store — S-2's "the specific job" plus what it names. */
function renderJob(store: Store, item: WorkItem, fieldClip: number): string {
    const blocks: string[] = [jobStatement(store, item)];

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
        // D-33c/D-33d: the crew is told WHY a proposal is stuck, in the bracket it reads the refusal
        // against. Added ONLY when a Proposal row is actually in front of this job AND the Story has
        // unresolved issues, so every brief without a proposal row — which is every brief in every
        // existing fixture — renders byte-identically, and the sentence appears exactly where the crew
        // would otherwise waste a turn rediscovering the rule by calling the tool.
        const openIssueCount = findings.some((finding) => finding.kind === 'proposal')
            ? openIssueFindings(store, item.storyId).length
            : 0;
        const blockedNote =
            openIssueCount > 0
                ? `, ${openIssueCount} unresolved ${openIssueCount === 1 ? 'issue' : 'issues'} — no Proposal is filed or approved until they close (D-33c, D-33d)`
                : '';

        // The note goes INSIDE the bracket rather than after it: the count and the reason are one fact
        // about the same tray, and a heading that reads `(2), 1 unresolved issue …` makes the second
        // number look like a second tray. Nothing is appended at all when there is no proposal row or no
        // open issue, which is every brief in the existing fixtures (`brief_hash` stays put, §4.13).
        blocks.push(
            `Findings in front of you (${findings.length}${blockedNote}):\n${findings
                .map(
                    (finding) =>
                        `- ${finding.id} [${finding.state}, cost ${finding.cost}, seen ${finding.seen_count}×, criterion ${
                            finding.criterion_ref
                        }${
                            // T5: the marker is printed ONLY on a Proposal, so a plain issue renders
                            // byte-identically to every earlier brief (and every fixture), while the
                            // Editor's job line above can point at a word it actually sees here.
                            finding.kind === 'proposal' ? ', proposal' : ''
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

        // D-19: a directive is a decision the loop must PROPAGATE, so its text is the job. The
        // server already resolved the artifacts the sentence names; that list is advisory context
        // for the Editor's task plan, never a substitute for reading the book.
        blocks.push(
            directive === undefined
                ? `Directive ${item.directiveRef}: (no such record)`
                : `Directive ${item.directiveRef} [${directive.state}]: ${clip(directive.text, 1_000)}`
        );

        if (directive !== undefined) {
            const targets = directive.targets ?? [];

            blocks.push(
                targets.length > 0
                    ? `The server resolved the sentence to these artifacts: ${targets.join(', ')}. Name the ones the work really changes in each task's \`detail\` so the sweep can route it (D-19, D-11).`
                    : 'The server found no artifact this sentence names directly at this phase. Create the work that follows from the directive, or file the finding that says why it cannot be done (D-19).'
            );
        }
    }

    return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Tool etiquette (short on purpose — T-13: a rule with a tool behind it needs one line)
// ---------------------------------------------------------------------------

function renderEtiquette(kind: RoleKind, structureSeat?: PhraseStructureInstructionSet): string {
    // §7.2's researcher row: its write is Knowledge, never the book. Stated as its own line
    // because the generic "every tool is registered" sentence would otherwise read as permission
    // to reach for a story artifact — P10 refuses that call, and a brief should teach the route
    // before the refusal does (T-1a).
    const researcherLines =
        kind === 'researcher'
            ? [
                  'You are the Researcher: never write a story artifact (P10) — no Summary, plotline, chapter, Idea, verdict or finding. Your writes are `writeKnowledge` and `retireKnowledge` only; `readKnowledge` is how you check what is already known before you research it again.',
                  'Every entry cites a source you actually read, and the source backs the claim you attached it to (T-10). A claim you cannot source belongs in a task or in `requestAuthor`, not in Knowledge — escalate rather than guess (P7).',
                  'When this job\'s questions need no outside lookup — the Seed states every fact the story depends on, or `readKnowledge` already answers them — close the pass with `reportNoResearch` and one line saying why (D-51). That IS a report: it writes nothing, it ends the run, and the loop goes on to sample. Manufacturing a source to justify the run is the failure this rule exists to stop.'
              ]
            : [];

    // THE CLOSING LIST IS PER-SEAT (S-4, R7) — see `catalogue.ts:reportToolsForStructureSeat`. Every
    // crew that is not a phrase's structuring seat is handed S-4's whole union, exactly as before; a
    // structuring seat is handed the union minus the OTHER phrase's structuring write, because that one
    // call is the tool this seat must not end on. For Phrase ① the two lists are the same string — its
    // seat keeps `structureSeed` and never saw `structurePlotlines` — so every phase-① brief renders
    // byte-identically, and the only brief whose sentence changes is the Phrase ② seat's own.
    const reportTools =
        structureSeat === undefined ? REPORT_TOOLS : reportToolsForStructureSeat(structureSeat.declaresChapterCount);

    return [
        ...researcherLines,
        `Every tool in §8 is registered on this session whatever your kind — ${permissionLine(kind)}. A call your kind may not make is REFUSED at the call, naming the rule (T-1a), so try rather than guess: a refusal is information, not a failure.`,
        "`listTools` lists the catalogue this session holds and `describeTool` gives one tool's exact shape (T-6c) — cheaper than guessing a field and being refused (T-11).",
        'Every mutating tool takes `expects: [{id, rev}]` and `why` (T-4, T-5). A rejected write returns the CURRENT record: re-read what it says now, re-apply your change against that, and send it again with the rev you were handed. Never force — concurrent crews are expected, not exceptional (T-4).',
        'Every tool result names the revision it was read at (T-8), so your next `expects` can be correct without a second read.',
        'If the Digest is not enough to judge, file a `digest_gap` finding (D-13) rather than reading the whole book — reading past this brief is the signal the Digest needs work (E-2).',
        'If this brief asks for something no tool can do, call `reportGap` naming the job, what you needed and what you did instead (T-12). Do not improvise a workaround the Author will read as a choice.',
        // S-4 vs D-30 — the contradiction a Critic used to read straight through: this line said "a run
        // that reports nothing is a no-op turn" while the review banner says an empty pass is a valid
        // outcome, and "reports nothing" reads like "files nothing". They are different acts, so the
        // sentence now names them separately: the ledger counts the MISSING REPORT, and a pass that
        // files nothing and says so is a completed pass. The Writer clause is unchanged — for a Writer,
        // writing nothing AND escalating nothing is still a brief defect (S-4).
        `End the run ONLY after reporting with one of: ${reportTools.join(', ')} (S-4). What costs the Story a turn is the missing REPORT, never an empty set of findings: a pass that files nothing and reports that the text holds has done its job, while a run that ends without one of these calls is a no-op turn counted against the Story — and a Writer run that wrote nothing and escalated nothing is a bug in its brief, not a cost.`,
        'Before you end, put anything you learned into the store: if it is not in the store it was not produced (P1, P3).',
        // THE CHAPTER-COUNT CLAUSE IS PER-SEAT (R3, D-3b). Every crew in the book is told "never touch
        // `chapter_count`", and for every crew but one that is exactly right — the number is the Author's
        // (D-3b) and an authoring crew that edits it is the bug the rule exists for. The ONE seat that
        // declares it is a phrase's structuring Editor, whose single write accepts the brief and moves the
        // count in the same commit, so for that seat the flat prohibition contradicts its own job sentence
        // two sections above: it would be told to decide a number it may not write. The clause is chosen
        // from the seat's `declaresChapterCount`, not from a phrase branch here.
        structureSeat?.declaresChapterCount === true
            ? 'Never `updateDigest` — the engine derives it (D-12a). Never lock, unlock or backtrack (D-1). `chapter_count` is the ONE count you declare, and you declare it by the single structuring call your job names — never by editing the Summary row, and never beside the count on the record without saying why (D-3b).'
            : 'Never `updateDigest` — the engine derives it (D-12a). Never lock, unlock or backtrack (D-1). Never touch `chapter_count` (D-3b).'
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
 * D-30 — a Critic's phase-① REVIEW pass. The role prompt describes the Critic's whole
 * capability (including Ideas and research, for jobs that ask for them); a review pass narrows
 * that to "judge this sample": defects only, critical/major first, and no open-ended mining for
 * minor polish. The banner is rendered BEFORE the role prompt because it is the binding mode.
 */
const isCriticReview = (item: WorkItem): boolean => item.kind === 'check_unit' && item.roleName === 'critic';

/**
 * LIVE OPEN-ISSUE STATE — the fact the Critic's brief never carried (2026-11-26, D-33c).
 *
 * WHY THIS IS A MECHANISM AND NOT PROSE: the D-33c RULE ("a Proposal over an open issue is dismissed")
 * was stated in four places and the live FACT in none, and a Critic review job carries no
 * `findingRefs` — the deep-review dispatch sites in `loop/work.ts` never set them — so the
 * open-issue count in `renderJob`'s findings bracket (see the `Findings in front of you` heading) is
 * unreachable for this pass. The only way to learn whether a Proposal was admissible was to SPEND A
 * TOOL CALL finding out, and every refused call is a full round-trip that is deliberately not deduped
 * and invisible to the progress ledger. Measured: 10 records naming a proposal refusal in one
 * 33-minute run.
 *
 * So the count is read HERE, out of the store, and printed before the role prompt: the same single
 * predicate the tool's own gate uses (`loop/records.ts:openIssueFindings`, shared with the Editor's
 * `approveFinding`, the dial sweep and the Clean stamp), which is what keeps the number in the brief
 * from ever disagreeing with the number the dismissal quotes.
 *
 * ONE LINE, BOTH BRANCHES, NO INVITATION: with an issue open, a Proposal is DISMISSED (not refused,
 * not parked, not deferred), so the line says "issues only" and offers nothing to try later. With none
 * open it says the opposite, truthfully — a Proposal is admissible — so the sentence cannot be read as
 * a blanket ban. Both branches are asserted in `run/brief.test.ts` against a real store state, not
 * against a hand-written count.
 *
 * `brief_hash` (§4.13) stays a pure function of stored state: the count comes from finding rows, with
 * no clock and no tool read, exactly like the findings bracket. It does mean a Critic brief assembled
 * before and after an issue closes hashes differently — which is the point: the run WAS told different
 * things.
 */
function criticOpenIssueState(store: Store, item: WorkItem): string {
    const openIssues = openIssueFindings(store, item.storyId);

    if (openIssues.length === 0) {
        return 'LIVE STATE — no issue is open on this Story right now, so a Proposal you are certain of is admissible in this pass: file it with the verdicts in the one report you end with.';
    }

    return `LIVE STATE — ${openIssues.length} ${openIssues.length === 1 ? 'issue is' : 'issues are'} open on this Story right now, so a Proposal filed this pass is dismissed: no row, no work armed, and nothing to retry. Spend this pass on issues only.`;
}

const CRITIC_REVIEW_MODE =
    // T3 — the admissibility rule lives HERE, in the banner, and not only in the four angle
    // templates: the banner is engine-owned, it is rendered BEFORE the role prompt, and it declares
    // itself the override, so an Author who rewrote `critic-genre` still gets the rule. The same words
    // are in the JOB line below (`jobStatement`'s `check_unit` critic branch) and in the sweep note's
    // first 600 characters (`loop/work.ts`), which is the only part of the note `renderJob` keeps —
    // pinned by `run/brief.test.ts` and `loop/phase1-verdict-contract.test.ts`. Nothing here weakens a
    // contradiction check, and phases ② and ③ keep their setup-and-payoff review.
    //
    // D-33c REWRITTEN 2026-11-26 to match what the tool now does, and the stopping rules converged
    // with it. `tools/reader.ts:dismissedProposal` replaced the refusal: a `kind: proposal` call that
    // meets an open issue is DISMISSED (no row, no work, no retry), so the banner no longer describes a
    // refusal the crew can argue with or try again, and the retired mirror rule ("an issue and a
    // proposal never share a pass", which threw a DEFECT away when a pass had already filed an
    // improvement) is gone from here, from the job line, and from the retry invitations that came with
    // it ("bring it in a pass that has none left", "in the next review"). Both are invitations to spend
    // a round-trip on a question the rule has already answered — the owner's complaint. What replaces
    // them is the effort-then-value rule and the one-terminal-report rule, stated once here and echoed
    // in the job line and the done-line so the three cannot drift.
    'PASS MODE — REVIEW (this overrides any wider instruction in the role prompt below). The Summary sample and the Seed are in this brief; call `readSummary` only if the brief does not carry the sample or says it was clipped. Use the read tools your angle needs — the ledger only where a continuity point turns on it — and research only the specific factual claim you doubt (one citable source is enough). Do not read the whole book or unrelated artifacts, and do not propose Ideas in this pass. TWO KINDS OF FINDING, and the row says which one it is: an ISSUE (`kind: issue`, the default) is something that breaks the story’s logic, contradicts a commitment, or rests on a claim the text cannot support, and it is rated `critical`, `major` or `minor` — never `taste`. A PROPOSAL (`kind: proposal`) is an improvement the Seed never had to promise — a word change, a new element, a twist linked earlier — and it is rated `major`, `minor` or `taste`, never `critical`. WHAT COUNTS AS AN ISSUE: the Seed and its Brief are commitments, not an exhaustive outline — the Writer may invent any specific they do not rule out. So an added detail, a field the Seed leaves silent or marks in `open_questions`, stakes or consequences the Seed never stated, and setup or foreshadowing a Summary did not promise are NOT defects by themselves, and never a C-14 finding; do not demand explicit stakes, consequences or planting from a Summary unless an explicit Seed or Summary commitment, or an actual contradiction, makes it necessary. A Summary is a set of facts and consequences, not prose: word choice, sentence shape, grammar and register are never an Issue at this phase — they are a PROPOSAL at cost `taste` or `minor` — because the sentences that would carry them are written in phase \u2462, and a `taste`-cost Issue is refused on the call (`tools/reader.ts:raiseFinding`). What IS reviewable: a real contradiction of what the Seed, the Brief or established critical Knowledge states, a real contradiction inside the artifact itself, a clear failure to carry a commitment the Seed states centrally (as distinct from a detail it leaves open), and the artifact contradicting or leaving unpaid a promise the artifact itself makes. A finding must quote that evidence — a finding that quotes only an absence, and cannot quote what it contradicts, is not admissible. The one exception is a PROPOSAL: a change that would genuinely improve the book while contradicting nothing is filed with `kind: proposal`, titled as a proposal and quoting the passage it would improve, and the Editor weighs it on whether the story is better for the pass rather than on whether the Seed promised it. On a book whose Summary is written group by group, the Summary in front of you is the OVERVIEW of five separately revised groups: name in `group_refs` the group or groups your quote is about, copied from the `phrase_groups` pairs the Summary block prints, and one defect crossing several groups is one finding, not several. In later phases the chapter and plotline setup-and-payoff checks (C-4, C-5, C-6) stay exactly as they are. Report the critical and major issues first — a minor Issue and any Proposal are optional and must not keep you searching. Every finding must carry `detail` (what is wrong and where — section, paragraph or lines), `evidence` (the quote or line range), `criterion_ref`, and the cost you believe; add `related_refs` when the defect touches another record. ISSUES COME FIRST, and the tool enforces it on the call (D-33c): while any issue on this Story is unresolved (only `unconfirmed`, `confirmed` and `approved` hold one open; an issue marked `disputed`, `fixed` or `discarded` releases it) a `kind: proposal` claim is DISMISSED rather than refused — nothing is written, no work is armed, and the answer offers no retry, because the dismissal settles that claim for this pass — while an issue stays filable at any time, whatever else is open. The LIVE STATE line printed with this banner is that same count, so no tool call is needed to learn it: with an issue open the claim worth filing is the DEFECT, and with none open a Proposal you are certain of is admissible in this pass. CONCLUDE, DO NOT MINE: report what you are certain of and stop. A defect you had to dig for is not worth filing, nit-picking is forbidden, and a minor note or an improvement you cannot name against a quotation is not worth the call. Once the issues you are certain of are filed this pass is finished, and it ends with ONE terminal report — `submitVerdict` carrying both verdict lines the Goal and the crew panel need AND every finding you are filing — with the thread over the moment it fires, so nothing is filed after it and no second report is owed. A pass that files nothing and reports that the text holds is a completed pass: S-4 counts a run that never REPORTS, never a run that filed no finding, so an empty pass is a valid, good outcome and inventing a finding to fill one costs the book a Writer round.';

/**
 * Phase ②'s binding banner. The Summary banner above is wrong for chapter contracts in three
 * specific ways, and each one is the failure this constant exists to stop:
 *   - the artifact is the chapter CONTRACTS plus the phrase seed, not the Summary sample;
 *   - word choice and staging are phase ③'s, so "contracts, not prose" is the calibration;
 *   - the criteria are C-7/C-8/C-9 (or the plotline contract's C-0…C-6), never C-14/C-15.
 *
 * It keeps the D-33b/D-33c ladder and the one-terminal-report rule, because those are phase-
 * independent; only the artifact, the evidence and the criteria change.
 */
const CHAPTER_CONTRACT_REVIEW_MODE =
    'PASS MODE — CHAPTER-CONTRACT REVIEW (this overrides any wider instruction in the role prompt below). The chapter contracts and the phrase seed are in this brief; use the read tools your angle needs — the ledger only where a setup/payoff point turns on it — and research only the specific factual claim you doubt (one citable source is enough). Where the role prompt below says the Summary or its five groups, read the CHAPTER CONTRACTS; where it cites C-11, C-12 or C-13, use C-7, C-8 or C-9 for a chapter contract and C-0 through C-6 for the plotline contract the chapter fails. Do not read the whole book or unrelated artifacts, and do not propose Ideas in this pass. Judge CONTRACTS, not prose: a contract may be SPARSE and still correct, and a note that you would have staged the chapter differently is not a defect — phase ③ writes the sentences. TWO KINDS OF FINDING: an ISSUE (`kind: issue`, the default) is a contradiction you can QUOTE — a payoff with no setup, a setup no later chapter collects, a state or knowledge that resets, a contract that contradicts the phrase seed or critical Knowledge — and it is rated `critical`, `major` or `minor`, never `taste`. A PROPOSAL (`kind: proposal`) is an improvement the seed never had to promise, rated `major`, `minor` or `taste`, never `critical`. An absence is not a defect; a finding must quote what the contract contradicts. EVERY finding names the chapter `group_refs` it is about, copied from the ids the prompt prints: one chapter when the fault is inside one contract, several when the defect is how they fit together, and ONE finding when it crosses chapters — never one finding per chapter. Quote the line from the group you name in `location`; name only groups you actually read. Report the critical and major issues first; a minor Issue and any Proposal are optional and must not keep you searching. ISSUES COME FIRST (D-33c): while any issue is on this Story, a `kind: proposal` claim is DISMISSED on the call — no row, no work armed, no retry to spend. The pass ends with ONE terminal report — `submitVerdict` carrying the goal verdict at the Story row AND every finding in `findings[]` — and the thread is over the moment it fires, so nothing is filed after it. A pass that files nothing and reports that the contracts hold is a completed pass.';

/**
 * Phase ③'s banner (and any future prose-level `check_unit` Critic): the Summary's "prose is
 * never an Issue at this phase" sentence is exactly backwards here, so this mode states that C-10
 * through C-13 are reviewable and that word choice, sentence shape, grammar and register ARE
 * reportable. The rest of the finding ladder and the one-terminal-report rule are phase-independent.
 */
const PROSE_REVIEW_MODE =
    'PASS MODE — PROSE REVIEW (this overrides any wider instruction in the role prompt below). The chapter prose and its contract are in this brief; use the read tools your angle needs — the ledger only where a continuity point turns on it — and research only the specific factual claim you doubt (one citable source is enough). Where the role prompt below says the Summary or its five groups, read the CHAPTER PROSE; its C-14/C-15 citations do not apply here. Do not read the whole book or unrelated artifacts, and do not propose Ideas in this pass. Judge the PROSE this phase wrote: C-10, C-11, C-12 and C-13 apply, and word choice, sentence shape, grammar and register ARE reviewable here — the Summary-phase rule that prose is never an Issue does not apply to this pass. A finding must quote the line it is about; an absence is not a defect. TWO KINDS OF FINDING: an ISSUE (`kind: issue`) is a defect, rated `critical`, `major` or `minor`, never `taste`; a PROPOSAL (`kind: proposal`) is an improvement, rated `major`, `minor` or `taste`, never `critical`. EVERY finding names the chapter or Story `group_refs` it is about, copied from the ids the prompt prints, and one defect crossing several artifacts is ONE finding. Quote the line from the group you name in `location`; name only groups you actually read. ISSUES COME FIRST (D-33c): while any issue is on this Story, a `kind: proposal` claim is DISMISSED on the call. The pass ends with ONE terminal report — `submitVerdict` carrying the goal verdict AND every finding in `findings[]` — and the thread is over the moment it fires. A pass that files nothing and reports that the prose holds is a completed pass.';

/**
 * The banner for a `check_unit` critic, selected by the PHASE rather than by the role name alone.
 * `isCriticReview` used to be phase-agnostic, so a chapter-contract review received the Summary
 * banner ("The Summary sample and the Seed are in this brief", "never a C-14 finding") while its
 * job note said chapter contracts. That mismatch is the reason this selector exists.
 */
const criticReviewModeOf = (item: WorkItem, story: Story): string => {
    // The artifact decides first: a Summary deep review keeps the Summary banner even when the
    // Story has advanced past phase ①.
    if (isSummaryCriticReview(item, story)) return CRITIC_REVIEW_MODE;
    if (story.phase === 'plotlines') return CHAPTER_CONTRACT_REVIEW_MODE;

    return PROSE_REVIEW_MODE;
};

/**
 * The review pass's own done-definition. CS-VERDICT-1: it names the SAME two targets as the job
 * sentence, in the same order. "the sample is rated" left the target ambiguous, and a Critic that
 * rated only the draft left the Goal reading `no verdict yet` while the crew panel showed four
 * passing reviews; the done-line is the last thing the crew reads before the tool catalogue, so a
 * target stated here and nowhere else is the failure mode this prevents.
 *
 * 2026-11-26: the done-line is also the pass's STOPPING rule, so it carries the converged wording —
 * "every issue you are certain of", not "everything you can find" — and states that both verdict lines
 * sit in the ONE terminal report rather than in two calls (the old "the goal verdict is filed with
 * `submitVerdict` at X AND at Y" phrasing read as two filings and bought two round-trips).
 */
const criticReviewDone = (item: WorkItem, story: Story): string => {
    const targets = criticReviewTargetPhrase(item, story);

    // A chapter-contract review owes ONE goal verdict at the Story row, not the Summary's two
    // lines. The wording is derived from the same target helper the job line uses, so the two
    // cannot drift apart.
    if (!isSummaryCriticReview(item, story)) {
        return `Done means: every issue you are certain of — critical and major first — is filed as a \`findings[]\` entry of the ONE terminal \`submitVerdict\` you end with, at ${targets.unit}, with its detail, quoted passage, criterion and evidence line; and you stopped there instead of digging for a defect worth less than the round it would buy. No Idea is filed in a review pass.`;
    }

    return `Done means: every issue you are certain of — critical and major first — is filed with its detail, quoted passage, criterion and evidence line; BOTH verdict lines sit in the ONE terminal \`submitVerdict\` report you end with, at ${targets.unit}${
        targets.revision === undefined ? '' : ` AND at ${targets.revision}`
    }; and you stopped there instead of digging for a defect worth less than the round it would buy. No Idea is filed in a review pass.`;
};

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
    //    run from every other kind holding the same tool catalogue (T-6a). A Critic REVIEW pass
    //    gets its mode banner first, and its own done-definition: the template's angle prompt
    //    describes the whole Critic capability (Ideas, research), while this pass is bounded.
    const roleLines: string[] = [];

    if (isCriticReview(item)) {
        // Banner first (it is the binding mode, and it declares itself the override over the role
        // prompt below), then the LIVE open-issue count. Both are engine-owned and both sit ahead of
        // the Author-editable angle prompt, so neither can be reworded away. The count is its own
        // paragraph — `tools/reader.ts:dismissedProposal` answers with it, and the pass is told the
        // fact before it spends a call discovering it.
        roleLines.push(criticReviewModeOf(item, story), criticOpenIssueState(store, item));
    }

    roleLines.push(
        harness.role?.prompt ??
            '(no role prompt was found for this template — follow the job, the criteria and the permission line below, and treat the absence as a template defect to report, D-17a)'
    );

    if (harness.warning) roleLines.push(`WARNING: ${harness.warning}`);

    if (isCriticReview(item)) roleLines.push(criticReviewDone(item, story));
    else if (harness.template?.done_definition) roleLines.push(`Done means: ${harness.template.done_definition}`);
    // D-17c: `selection_rules` is the Editor's brief in the Author's own words — and C-13 is
    // defined against it, so a reader grading C-13 needs it too (P12: without it the crew is
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

    // 3b. The Seed Brief (§3.3) — the Editor's DERIVED projection of the Seed. Every normal run
    //     sees it right after the Seed because it is the machine-readable form of the same truth:
    //     the Seed stays law (P5), and the brief is what a Worker can actually check a draft
    //     against. Omitted when the Story has no accepted brief yet — a stated absence already
    //     exists above (the raw Seed), and an empty heading would only add noise.
    const seedBrief = acceptedSeedBrief(store, story.id);

    if (seedBrief !== undefined) {
        parts.push({
            heading: SEED_BRIEF_HEADING,
            body: renderSeedBrief(seedBrief)
        });
    }

    // 3b-ii. THE STRUCTURE SEAT'S ARTIFACT (R1). A `structure_seed` job is generated by the phrase that
    //        owns the seed being structured, and Phrase ②'s seed is NOT `stories.idea`: it is the text
    //        the Author pushed into the Plotlines Phrase (`phrase/catalog.ts:phraseSeedOf`), the one
    //        every Phrase ② gate hashes. Until now it reached the brief only inside the sweep note, and
    //        `renderJob` clips the note at 600 characters — of which this job's instruction took 535 — so a
    //        whole 1,714-character compiled Overview arrived as a 65-character fragment plus a "read the
    //        full record" tail naming `readSeed`, the one read that cannot return it (`phrase_id` is not a
    //        `readSeed` field). Measured: `Temp/create-storyline-probe/probe-4-full-brief.ts`.
    //
    //        THE SEED IS NOT TRIMMABLE, and that is a decision, not an oversight: E-1/D-13 say the brief
    //        IS the artifact under review, and E-0 forbids trading a rule for a character count. This
    //        section is therefore rendered whole, outside the trim ladder, exactly as
    //        `run/phase1-prompt.ts:phraseSeedSection` already renders it for Phrase ②'s no-tool seats
    //        (the compiled-prompt path got this section in T-W2; the assembled-brief path never did).
    //        The note is what shrinks instead — it now carries the instruction and the hash, and fits the
    //        clip with room to spare (`loop/work.ts:1614`).
    //
    //        Phrase ① returns `undefined` here: its seed IS `stories.idea`, and the section above
    //        already carries it, so every phase-① brief renders byte-identically.
    const structureSeat = item.kind === 'structure_seed' ? phraseStructureSeatOf(item.id) : undefined;
    const structureSeedSection = structureSeat?.seedSection({ store, story });

    if (structureSeedSection !== undefined) parts.push(structureSeedSection);

    // THE SEAT-AWARE RUNG, decided once here where the seat is known (D-b). A seat that mounts its OWN
    // untrimmable artifact section has been handed the text it structures; the phase-① `SEED BRIEF`
    // mounted above is then the derived projection of a DIFFERENT phrase's Seed, and the seat's own job
    // sentence already says so — the wording is the controller's, reached through the seam this file
    // already calls (`phrase/controller.ts:phraseStructureSeatOf(item.id)`, the controller's
    // `instructions.structure.job`, implemented by `phrase/controllers/plotlines.ts:plotlinesStructureJob`):
    // "Phrase ①’s `SEED` section above is context only, and so is the derived `SEED BRIEF` — and that second
    // heading is NOT one this brief guarantees you" (F3: the copy states the TRADE rather than claiming the
    // heading is present, because this rung decides the section's fate after the job text is written, and on
    // the built-in template this seat's brief is over budget at every seed size — `Temp/c9/probe-f3.out`).
    // It is therefore
    // the one section this brief may lose without losing a rule — unlike the Seed, the Digest, the
    // criteria, the artifact and the job, which E-0 refuses to trade for a character count. The flag is
    // derived from the seat's own declaration (`seedSection` returned a section), never from a phrase
    // name, so Phrase ① — whose `seedSection` is `undefined` because its `SEED` section already IS the
    // artifact — keeps every section it has always kept, byte for byte.
    const seatTrimHeading = structureSeedSection === undefined ? undefined : SEED_BRIEF_HEADING;

    // 3c. The Knowledge a tool run must not contradict (§3.2, §5). Same filter and order as the
    //     compiler (`critical` then `high`, by fingerprint); the brief omits `detail` so a long
    //     research corpus cannot push a chapter brief past E-3 — `readKnowledge` carries the rest.
    const knowledge = renderKnowledgeBlock(promptKnowledge(store, story.id));

    if (knowledge !== '') parts.push({ heading: 'KNOWLEDGE — critical and high', body: knowledge });

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

    // 9. Tool etiquette: T-4 CAS and re-read, T-5 why, S-4's closing obligation, D-13/T-12 gaps. The
    //    chapter-count line follows the seat, because for ONE seat `chapter_count` is its product rather
    //    than a forbidden field (D-3b, R3).
    parts.push({ heading: 'TOOLS AND HOW TO END', body: renderEtiquette(harness.kind, structureSeat) });

    // 10. The competing drafts, for the two kinds only that may see them (D-21). Rendered last
    //     because it is the section the trim ladder exists for: N whole drafts is the only part
    //     of a brief that can outrun E-1 by itself.
    const showsRevisions =
        ((item.kind === 'select' || item.kind === 'merge') && !!item.unit?.ref) ||
        (item.kind === 'check_unit' && item.revisionRef !== undefined);

    return renderWithinBudget(parts, store, item, story, showsRevisions, seatTrimHeading);
}

/** The heading names the unit so an agent cannot mistake which record it is judging. */
function artifactHeading(store: Store, item: WorkItem, story: Story): string {
    // §6.1's two new tool-carrying kinds. The Editor's structure pass reads the Seed and writes a
    // DERIVED brief (the Seed itself is never edited, P5); the Researcher's pass produces the
    // Story's Knowledge, so its "artifact" is what the book's facts rest on (§3.2). The structure pass's
    // heading is phrase-owned like its job sentence (R7): Phrase ①'s is the Seed, Phrase ②'s is its own
    // copied seed, and a heading that named the wrong one is how the two seats got tellable apart in the
    // integration harness (`integration/harness.ts:939`).
    if (item.kind === 'structure_seed') return phraseStructureSeatOf(item.id).artifactHeading({ store, story });
    if (item.kind === 'research') return "the Story's knowledge (research pass)";

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
        if (story.phase === 'summary') blocks.push(`Summary:\n${renderSummaryFields(store, story, fieldClip)}`);

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

        blocks.push(`Summary sheet:\n${renderSummaryFields(store, story, fieldClip)}`);

        return blocks.join('\n\n');
    }

    if (item.unit.kind === 'summary') blocks.push(`Summary:\n${renderSummaryFields(store, story, fieldClip)}`);

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
 *
 * THE ONE SECTION THAT MAY BE DROPPED, AND ONLY WHEN NOTHING ELSE WORKED: `seatTrimHeading` names the
 * section this seat is not entitled to (see {@link assembleBrief}, D-b). It is tried as a SECOND pass,
 * after the whole ladder has already run, and only while the brief is still over budget — so a seat
 * brief that fits keeps the section, the ladder's order is untouched for every other run, and the
 * section that goes is the one the seat's own job sentence already demotes to "context only". The
 * untrimmable sections stay untrimmable whatever the count: E-0's "no rule for a number" (D-13, E-1).
 */
function renderWithinBudget(
    parts: Part[],
    store: Store,
    item: WorkItem,
    story: Story,
    showsRevisions: boolean,
    seatTrimHeading?: string
): AssembledBrief {
    const rendered = renderTrimLadder(parts, store, item, story, showsRevisions);

    if (rendered.text.length <= BRIEF_CHAR_BUDGET || seatTrimHeading === undefined) return rendered;

    // The section is not mounted for this job at all, so the rung has nothing to take: over budget on
    // purpose, exactly as every over-budget brief was before this rung existed.
    if (!parts.some((part) => part.heading === seatTrimHeading)) return rendered;

    return renderTrimLadder(
        parts.filter((part) => part.heading !== seatTrimHeading),
        store,
        item,
        story,
        showsRevisions
    );
}

/** One walk down {@link TRIM_LADDER}: the first render that fits, or the last step's over-budget text. */
function renderTrimLadder(
    parts: Part[],
    store: Store,
    item: WorkItem,
    story: Story,
    showsRevisions: boolean
): AssembledBrief {
    for (const step of TRIM_LADDER) {
        const input: RenderInput = {
            notes: renderChangeNotes(store, item.storyId, item.unit?.ref, step.notes),
            revisions: showsRevisions ? renderRevisionsForItem(store, item, step.clip) : '',
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
                revisions: showsRevisions ? renderRevisionsForItem(store, item, lastStep.clip) : '',
                clip: lastStep.clip
            },
            lastStep.clip
        ),
        {
            notes: '',
            revisions: showsRevisions ? renderRevisionsForItem(store, item, lastStep.clip) : '',
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
