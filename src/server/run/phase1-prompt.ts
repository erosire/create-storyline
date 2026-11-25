// The Phase-1 prompt COMPILER (documents/phase-1-research-pipeline.md §5) — the one pure
// function that turns stored state into the Writer's first prompt and the screening Critic's
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

import {
    GROUP_DRAFT_SCHEMA_NAME,
    GROUP_LOCK_SCHEMA_NAME,
    GROUP_REVIEW_SCHEMA_NAME,
    ISSUE_LIST_SCHEMA_NAME,
    SECTION_SCORES_SCHEMA_NAME,
    SUMMARY_SAMPLE_SCHEMA_NAME
} from '../../shared/schemas';
// SUMMARY PHRASE: the group rows, their catalog definitions, and their current texts; D-67 adds the
// CLEAN SELECTION, which is the only text the Reader's scoring pass may be shown. `server/phrase`
// imports nothing from the run layer, so this adds no cycle.
import {
    cleanSelectionOf,
    findingGroupScope,
    isPhraseGroupLocked,
    phraseGroupsOf,
    type ReviewedCompositionEntry
} from '../phrase';
// PHRASE GROUP LOCK: the ONE read that decides what the Editor's lock seat may weigh
// (`loop/editor-lock.ts:editorLockEvidenceOf`). The generator arms a seat from it and this compiler
// renders from it, so a prompt can never show evidence the seat was not entitled to — and the settle
// re-runs the same eligibility rules against the same rows. `loop/records` is already imported below,
// so the loop layer is a known, cycle-free dependency of this one.
import {
    GROUP_LOCK_CLAIM_RENDER_CAP,
    editorLockEvidenceOf,
    type EditorLockEvidence
} from '../loop/editor-lock';
import { phraseGroupDefinition } from '../../shared/phrase';
import type { PhraseGroup } from '../../shared/types';
// G-2: the criterion's `fix_hint` is the definition of done a fix task must carry, and the built-in
// roster is the only place it exists. Plain data, no library, so the server-only compiler can read it.
import { criterionById } from '../../shared/criteria';
import type { Criterion, Finding, KnowledgeEntry, Revision, SeedBrief, Story, Task } from '../../shared/types';
import type { Store } from '../store';
// T-10 / the G-9 fix: the fix block a Writer is graded on must contain ONLY rows the Writer can
// settle. `loop/records.ts:isWriterActionableFix` is the same predicate the sampler gate, the work
// queue and the round closure use, so the prompt, the offer and the certificate cannot drift apart.
// H2/R2 adds the OTHER half of that sharing: `acceptedSummaryRevision` is the row the selection gate
// scores a refinement against, and `compileScreenPrompt` must show the Critic that same text.
// Server-only module, and `loop/records` has no run-layer imports — this adds no cycle.
import { acceptedSummaryRevision, isWriterActionableFix } from '../loop/records';

/** One compiled prompt: the two turns a no-tool run is given, and the hash that names them. */
export interface CompiledPrompt {
    system: string;
    user: string;
    hash: string;
}

/**
 * The knowledge filter §5 states once: only `critical` and `high` enter a sampling prefix.
 * `normal`/`low` stay readable through `readKnowledge` for the deep-review Critic, and they must
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
 * its prose does not exist yet (phase ③ writes it). Before this calibration a screening Critic could
 * cost a comma or a preferred phrasing `high`, the round then resampled for a taste, and a second
 * Critic disliked the new phrasing — a hill that never converges because there is no top (the loop
 * the Author reported). Phrasing is now named as explicitly non-reportable, and the two severities
 * are defined over consistency, causality, timeline, world rules, motive and the Seed's own goal.
 *
 * T3 — the SECOND half of the same calibration, and the half that still cost rounds. The line below
 * used to read "A high fails to deliver something the Seed Brief promises", which let a screening
 * Critic treat a general Seed as an outline with unfilled boxes. Two of the Author's screenshots are
 * exactly that: a `UNCONFIRMED` note because the final hedgerow refuge appears only in the ending and
 * had no earlier planting in the Summary, and an `APPROVED` one because the Summary never says what
 * the bird loses if the search fails — a stake the Seed left open. Both are inventions the Writer is
 * allowed to make. Screening has no Editor or Critic pass downstream to dispute them either: its
 * issues rank the round on the spot (§6.5), so the rule lives in this ENGINE-OWNED text, not only in
 * the Author-editable `critic-screening` role prompt (a custom template replaces the system turn).
 * What is deliberately NOT relaxed: an issue still carries a verbatim `quote`, and the quote now has
 * to name what the draft contradicts — an absence cannot be quoted, which is the test that makes it
 * inadmissible rather than a matter of taste.
 */
const SCREEN_INSTRUCTION =
    'Report ONLY critical and high issues, and reserve those two words for what a Summary has to get RIGHT: ' +
    'a critical contradicts the Seed Brief or a critical Knowledge entry — a causal chain that does not cause, ' +
    'a timeline that cannot happen, a world rule the draft states and then breaks, a motive that does not explain ' +
    'the acts it grounds, or an ending that fails the Seed\u2019s goal. A high leaves unpaid a commitment the ' +
    'Seed Brief states EXPLICITLY. The Seed is general and is not an outline: where it is silent, or names a ' +
    'question in `open_questions`, the Writer may invent any specific that does not contradict it. So an added ' +
    'detail, a Seed question left open, stakes or consequences the Seed never stated, and setup the Summary did ' +
    'not promise are NOT issues, and never a `C-14` issue — reporting one costs this sample a comparison it ' +
    'should have won. What stays reportable is a contradiction — of the Seed, of critical Knowledge, or inside the ' +
    'draft itself — and a commitment the Seed states centrally the draft plainly does not carry. Proof is a ' +
    'quotation: an issue that can quote only an absence, and not what the draft contradicts, is an invalid answer. ' +
    'Word choice, sentence structure, grammar, register and a preference for another phrasing of the same ' +
    'commitment are NOT issues at this phase — they are minor, nothing here ranks them, and the prose that carries ' +
    'them is written and judged in phase \u2462. Quote the offending field verbatim in `quote`, name the field in ' +
    '`location`, cite `C-14`, `C-15` or `seed` in `criterion`. Return {"issues":[]} when the draft holds.';

/**
 * H1/R2 — the fix-verification contract, stated where the fix list is: in the TARGET DRAFT section,
 * so the whole screening batch still shares one system turn (§5's cache argument covers screens too).
 *
 * WHY THIS TEXT HAS TO BE THIS PRECISE: the array it produces is what the selection is gated on
 * (`sample-select.ts:scoreSample`), so a Critic that marks a fix `resolved` because the sentence
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
 * HILL CLIMB — the ORIGIN rule, asked of every screen that was handed the ACCEPTED draft, and in the
 * same section as the candidate because it is the same comparison: the Critic has the accepted draft
 * above and the candidate below, and only that pass can say whether a blocking issue is NEW in the
 * candidate or was already in the text being revised. H2/R2 — it does NOT require the fix certificate:
 * the gate scores the comparison whenever an accepted draft exists, and the queued fix list may be empty
 * by the time the screen runs.
 *
 * WHY THE ROUND NEEDS IT: an accepted Revision N already carries defects the Author has not targeted,
 * and a candidate that carries one of those did not break anything. Without the label the loop reads
 * every known flaw as a regression and rejects every draft it is able to write; with it, only a NEW
 * critical/major rejects a candidate, and an inherited one stays what it is — a fact about the work
 * list (`loop/sample-select.ts:scoreSample`). `unknown` is the honest third answer, and the selector
 * counts it as `introduced`: a pass that will not say cannot claim the draft is no worse than the text
 * the Author already signed.
 */
const ISSUE_ORIGIN_INSTRUCTION =
    'Every issue you report also names its `origin`: `inherited` when that same defect is already in the ' +
    'SELECTED DRAFT above, or `introduced` when the target draft below created it. The accepted draft is in ' +
    'front of you precisely so you can tell the two apart \u2014 a flaw the accepted draft already had is not ' +
    'this draft\u2019s doing, and a flaw it did not have is. Answer `unknown` when you cannot tell, and know the ' +
    'round reads `unknown` as `introduced`.';

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
    // HILL CLIMB: the round is graded on what it KEEPS as much as on what it changes. Before this line
    // a sampler could answer a fix task by breaking a fact the base draft had right, and the old §6.5
    // least-bad path would install it anyway because its issue counts were the round's smallest.
    '- Breaking something the base draft got right is a NEW defect: the critics compare your draft with ' +
    'the base, and one new critical or high rejects the draft however much else it fixed.\n' +
    '- Nothing here is judged on style: wording and sentence shape are settled in phase \u2462, when the chapters ' +
    'are written.';

// ---------------------------------------------------------------------------
// SUMMARY PHRASE — the group job's contract text and its section renderer (R2/R3/R5)
// ---------------------------------------------------------------------------

/**
 * The group Writer's answer contract, stated in the GROUPS section (the one place it is read next to
 * the groups it talks about, which is also where `compileScreenPrompt` puts its own instruction so the
 * system turn stays identical across a batch — §5's cache argument applies to a group batch too).
 *
 * WHY IT IS ENGINE-OWNED TEXT rather than template prose (R7): the group ids, the exact-set rule and
 * "content, not restatement" are the ANSWER CONTRACT, and a custom template replaces the system turn.
 * The role's own voice stays in the Author-editable template; this says what a valid answer looks
 * like, which is the part the engine has to be able to rely on.
 */
const GROUP_DRAFT_INSTRUCTION =
     'Answer with one `groups` entry for EVERY group named above, and for NO other group: `group_ref` is exactly the id ' +
     'in that heading, and `content` is that group\u2019s COMPLETE text — not a diff, not a note about it. A group this ' +
     'job did not name is not yours to rewrite, and a group it named that you leave out fails the whole batch: the ' +
     'engine installs an answer for all the named groups or for none, so a half answer buys nothing.\n' +
     '- Where the group already has a current text, REVISE it. Change what the FIX TASKS require and the coordinated ' +
     'minimum around it; keep every other commitment it makes, because the other four groups are being read against ' +
     'those facts right now.\n' +
     '- A fix task is answered by the group\u2019s CONTENT. Restating the same commitment in other words answers none of ' +
     'the tasks.\n' +
     '- Breaking a fact another group depends on is a new defect: the reviewers read all five groups together.\n' +
     // R2 — a batch is malformed three ways and all three are equally fatal, and a model told only
      // about the missing-group half answers with a duplicate or an id it invented. The refusal is
      // atomic (`phrase/revisions.ts:parseGroupDraftAnswer`), so the round is lost either way.
     '- The same group twice, or a `group_ref` this job never printed, fails the batch exactly as a missing one does: nothing is installed, and every group keeps the text it had.\n' +
     // H1/R2 — the Writer never certifies its own cure: the repair is real when a REVIEW pass can
      // quote the installed group that shows it, and a finding naming several groups closes only once
      // every one of them carries it (`phrase/findings.ts:findingGroupScope`).
      // D-66 (R12) makes that rule a FACT about the batch as well as an obligation, which is why the
      // sentence below says so out loud: `phrase/exclusion.ts:planGroupDraftBatch` never splits one
      // finding's groups across passes, so "I will finish the other group next sweep" is not an answer
      // the loop can take — there is no other pass for half a defect, and the finding stays open on the
      // text nobody rewrote.
     '- Your own word that a defect is gone proves nothing: the next review decides, by quoting the installed group that shows the repair. Answer the whole defect in every group it names, or claim nothing — and every group a fix names is already in THIS batch, because the loop never sends half a defect: one pass answers it in all of them, or the defect survives in the group you left alone.\n' +
     // PHRASE GROUP LOCK (R-lock) — the rule the engine already enforces in two writes
     // (`phrase/revisions.ts:installGroupRevisions` refuses an install over a locked group,
     // `phrase/exclusion.ts:groupWorkTargets` never puts one in a batch), stated where the Writer reads
     // it. It has to be in the PROMPT because a batch whose answer names a locked group is refused
     // WHOLE: the Writer would lose the pass for proposing a change that was never available to it.
     '- A group marked `LOCKED` — in the GROUPS block or in the LOCKED PEERS block above — is signed-off, FIXED text: never answer for one, never propose replacing a sentence of it, and treat the facts it states as facts your own groups must match. When a FIX TASK names a locked group, the repair belongs in the unlocked groups that can still move, because nothing can be rewritten there.\n' +
     '- Nothing here is judged on style: wording and sentence shape are settled in phase \u2462, when the chapters are ' +
     'written.';

/**
 * The group review's attribution rule, appended to the screening contract it shares.
 *
 * R3 is the whole point of this text: a complaint that names no group cannot be routed to a Writer,
 * cannot be re-checked group by group, and cannot ever be closed (a finding closes only when EVERY
 * group it names has a revision written to answer it). The two severity words and the quote rule come
 * from {@link SCREEN_INSTRUCTION} unchanged — the calibration is the same because the artifact is the
 * same kind of artifact, a Summary.
 */
const GROUP_REVIEW_INSTRUCTION =
    'EVERY issue you report names its `group_refs`: the group ids shown in the OVERVIEW section above. Name the one ' +
    'group the defect is in; name several, or all five, when the defect is in how they fit together \u2014 a promise the ' +
    'Ending does not keep, a Theme the Premise never grounds. An issue that cannot name a group is not an answer this ' +
    'pass may give: the loop routes work by group, and a defect with no group is work nobody can do.\n' +
    // R3 — the shape of an issue has to match the shape of the repair. A defect crossing three groups
     // is one Writer batch, so three issues would buy three revisions of the same text; the closure
     // join runs on the ids, so a multi-group fix is only certified once every group carries it; and a
     // review is a read, never a write, so there is no rationing argument for holding an issue back.
    'One defect that crosses several groups is ONE issue naming every group it crosses — never one issue per group, which would buy several rewrites of the same complaint. Say in `location` which group your `quote` came from and where in it the line sits: ids and headings are the address the Writer revises, prose summaries of the book are not. When the prompt carries FIX TASKS, a task whose finding names several groups is `resolved` only once EVERY one of those groups carries the repair — one group fixed is not the finding fixed. And this pass writes nothing: it spends none of the Story\u2019s rewrite allowance, so report what you find without rationing.\n' +
    // PHRASE GROUP LOCK (R-lock) — the reviewer's side of the same rule the Writer is held to. A locked
    // group IS still reviewable (its text can be contradicted by an unlocked one), and the domain routes
    // such a claim to the groups that can move (`phrase/findings.ts:findingActionableScope`); what the
    // reviewer must not do is file a complaint whose only possible repair is a rewrite of fixed text,
    // because the next Writer batch will not be able to answer it and the finding will sit on the Author's
    // queue as unworkable. The locked section is the BASELINE the unlocked side is measured against.
    'A group the OVERVIEW marks `LOCKED` is signed-off, FIXED text: the loop cannot rewrite it, and the Author alone unlocks it. Judge the Overview with that section as the baseline — its facts are the facts the other four must keep — and put the change where change is possible: name in `group_refs` the UNLOCKED group or groups that have to move so the Overview agrees with the locked one. A defect whose only home is a locked sentence is not work this book can do, so report it as what it is (a cost already paid) rather than as a repair the Writer owes.';

/**
 * The section score's contract (D-65), appended to the OVERVIEW section the same way
 * {@link GROUP_REVIEW_INSTRUCTION} is.
 *
 * WHY THIS TEXT EXISTS AT ALL: a number with no stated scale is a number the Author cannot compare
 * across revisions, so the three things judged, the range, and the one-line-per-section shape are
 * ENGINE-OWNED text rather than part of the Author-editable `reader-consistency` role prompt — the
 * same argument that put the review and draft rules here (`§5`'s cache rule wants the binding
 * sentences in one place). Deliberately absent: any sentence that would make a score DECIDE
 * something. The pass may not file a finding, open a task or grade a fix, and the instruction says
 * so, because a Reader whose number starts a Writer round would break P6 from the inside out.
 */
const SECTION_SCORE_INSTRUCTION =
    'SCORE EVERY SECTION ONCE. For each group printed above, give a whole number from 0 to 100 that answers one question: ' +
    'how well does this section hold up as written \u2014 its OWN internal logic, its consistency with the OTHER four sections ' +
    '(the Ending the Premise earns, the Theme the Promise carries, the Tone the facts support), and the plausibility of what it ' +
    'asserts? Anchor the ends: 100 is a section nothing in the Overview contradicts, 70 is sound with a seam you can point at, ' +
    '40 is a section that fights its neighbours, 10 is a section that contradicts itself. Deduct for a contradiction you can ' +
    'name; do NOT deduct for detail the Seed never promised, for prose the chapters have not written yet, or for a change you ' +
    'would personally prefer \u2014 that is a taste, not a fault, and a number that moves on taste is a number nobody can read. ' +
    'Copy each section\u2019s `group_ref` from the heading above into `group_ref`, give ONE short `rationale` (the reason for the ' +
    'number, in a sentence) and ONE `evidence` quote taken verbatim from that section \u2014 the line the judgement rests on, ' +
    'which for a cross-section fault is the line that cannot be true alongside the section you scored. Name every group exactly ' +
    'once and no group twice. This pass REPORTS a number: it files no finding, opens no task, grades no fix, edits nothing, and ' +
    'answers nothing else.\n' +
    // PHRASE GROUP LOCK (R-lock): one sentence, and it is here because a section marked LOCKED has no
    // future tense. The score still matters (the rail shows the trend), but a deduction for "I would have
    // written this differently" on text nothing may rewrite is a number the Author cannot act on.
    ' A section the heading marks `LOCKED` is signed-off, fixed text: score it exactly as written, and do not deduct for a change you would personally have made there, because no pass may make that change without the Author.';

/**
 * One group's section, for a Writer batch (with its current text, because a group revision is a
 * REVISION of a specific text) or for a review pass (with its revision number, because the review is
 * of a specific combination of five texts).
 *
 * THE ID IS PRINTED IN THE HEADING, and that is not decoration: `group_ref` is what the answer has to
 * carry (R2/R3), the model can only copy what it can see, and the id — not the key — is what the
 * engine writes against. The catalog definition is quoted from the CATALOG when the key is still
 * known and from the ROW when it is not, because a retired key still has rows with a title and a
 * description on them, and history should be read as it was filed (D-12a).
 */
function renderGroupEntry(
    store: Store,
    group: PhraseGroup,
    options: { current: boolean },
    /**
     * D-67: the CLEAN row this section must show, when the caller is rendering the REVIEWED Overview
     * (the Reader's scoring pass) rather than the installed one. It overrides both the number and the
     * text, because the whole point of the reviewed block is that a group's newest revision is NOT
     * necessarily the one the crew stands behind — an ending that went bad at r5 is scored at r4, and a
     * heading that said `revision=5` over r4's text would misreport the book to the model.
     */
    reviewed?: ReviewedCompositionEntry
): string {
    const definition = phraseGroupDefinition(group.key);
    const title = definition?.title ?? group.title;
    const description = definition?.description ?? group.description;
    const revisionNumber = reviewed?.revision.number ?? group.revision;
    const lines = [
        `### ${title} (group_ref=${group.id}, key=${group.key}, revision=${revisionNumber})`,
        description
    ];

    // THE GROUP LOCK, marked in the heading block of EVERY group renderer (Writer batch, group review,
    // Reader scoring, and the Editor's own lock seat all come through here, so one branch is the whole
    // feature and the three prompts cannot drift apart on what a locked section means).
    //
    // WHY IT IS HERE AT ALL: the loop already refuses to install over a locked group
    // (`phrase/revisions.ts:installGroupRevisions`) and already stops offering it
    // (`phrase/exclusion.ts:groupWorkTargets`), so a model that proposes a replacement for locked text
    // spends the batch on nothing — the whole answer is refused. The marker turns that invisible rule
    // into visible structure: the section that is law LOOKS like law, and the instruction that follows
    // says what to do with it (quote it as evidence, move the unlocked groups instead).
    //
    // It is printed ONLY for a locked row, so an unlocked book renders byte-identically to the way it
    // did before the lock existed (§5's cache argument, and every existing prompt hash, survives).
    if (isPhraseGroupLocked(group)) {
        lines.push(
            `LOCKED at revision ${group.locked_revision ?? group.revision}${
                group.locked_by ? ` by ${group.locked_by}` : ''
            } — signed-off, FIXED text: quote it as the evidence the other sections must match, and never propose replacing a sentence of it, because the engine refuses any rewrite of this section and the answer that tries one is refused whole.`
        );
    }

    if (!options.current) return lines.join('\n');

    // A reviewed row's content is non-blank BY CONSTRUCTION (`installGroupRevisions` refuses a blank
    // install), so the only branch the reviewed rendering needs is the plain one.
    if (reviewed !== undefined) {
        lines.push(`reviewed text, standing behind this section:\n${reviewed.revision.content.trim()}`);

        return lines.join('\n');
    }

    lines.push(
        group.content.trim() === ''
            ? 'current text: (this group has never been written — write it from the Seed Brief)'
            : `current text:\n${group.content.trim()}`
    );

    return lines.join('\n');
}

/**
 * The group block: the requested groups, in CATALOG ORDER, always.
 *
 * Order is not a courtesy here — a batch rendered in answer order would give two runs over the same
 * state different bytes, and §5's cache argument plus the prompt hash both assume one state, one
 * prompt. A requested id that names no group of this Story is dropped (it will be refused at
 * settlement anyway, and a phantom heading in a prompt teaches the model to answer for a group that
 * does not exist).
 */
export function renderGroupBlock(
    store: Store,
    storyId: string,
    groupRefs: readonly string[],
    options: { current: boolean; reviewed?: Map<string, ReviewedCompositionEntry> }
): string {
    const wanted = new Set(groupRefs);

    return phraseGroupsOf(store, storyId)
        .filter((group) => wanted.size === 0 || wanted.has(group.id))
        .map((group) => renderGroupEntry(store, group, options, options.reviewed?.get(group.id)))
        .join('\n\n');
}

/** The template slug whose `writer` role prompt is the sampler's system turn (§8). */
export const SAMPLE_TEMPLATE_SLUG = 'writer-summary-sampler';

/** The template slug whose `critic` role prompt is the screening Critic's system turn (§8). */
export const SCREEN_TEMPLATE_SLUG = 'critic-screening';

/**
 * READER SCORING (D-65): the template slug whose `reader` role prompt is the scoring pass's system
 * turn. The consistency reader is the built-in whose whole brief is "the contract chain has to
 * hold", which is what a cross-section score is; the scale and the answer shape stay engine-owned
 * (`SECTION_SCORE_INSTRUCTION`), so an Author editing this template tunes the voice, not the contract.
 */
export const SCORE_TEMPLATE_SLUG = 'reader-consistency';

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
 * The accepted Summary a candidate REPLACES — the text a round-N screen verifies AGAINST.
 *
 * Two reads, in priority order: the Summary `selectRevision` selected at the previous round (the row
 * the Writer was itself handed as `base_ref`, so Writer and Critic must see the same text), then
 * `loop/records.ts:acceptedSummaryRevision` — the row the SELECTION gate scores against. Under H1 a
 * round advances only by installing a certified draft, so the two agree; the fallback is what keeps
 * the prompt honest (and the origin rule asked) if the hill ever advances without installing, instead
 * of leaving the Critic blind while the gate still refuses the candidate for every issue the accepted
 * draft does not already carry. If those two reads ever disagree, the Critic is grading a different
 * pair of texts than the one the gate ranks — prefer changing both over changing one.
 */
function comparisonBaseOf(store: Store, storyId: string, round: number): Revision | undefined {
    if (round <= 1) return undefined; // a first round has no accepted Summary to replace

    return selectedSummaryRevision(store, storyId, round - 1) ?? acceptedSummaryRevision(store, storyId);
}

/**
 * The OPEN `fix` tasks §5 puts in front of a refinement sample, ordered priority DESC then id.
 *
 * T-10 / the G-9 fix — WRITER-owned rows only. A `fix` task whose `owner_role` names someone else
 * is not something a draft can settle, and grading a draft against it is what made a round
 * unsamplable: story_16's round 2 demanded `task_187 (unresolved on revision_102)`, a row opened
 * `owner_role: 'researcher'` for the plotline G-9 flagged as "a reference I cannot resolve", and the
 * Critic panels correctly answered `unknown` — "the draft names no research finding it grounded
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
 * One scalar Seed Brief field, or the stated absence.
 *
 * `stakes`/`obstacle`/`setting` and friends are REQUIRED on the record, so a brief whose Seed left
 * them open still carries the key — and it rendered as `stakes: ` with nothing after it. A Critic
 * reads a blank field as an unpaid promise, which is the exact complaint the Author reported ("the
 * Summary never says what the bird loses"): the Seed left the stake open, the Editor recorded that in
 * `open_questions` as its instructions require, and the blank line in front of the Critic looked like
 * a commitment the Summary broke. Naming the silence turns it back into what it is — the Writer's to
 * fill with any compatible detail — and it keeps the prompt a pure function of the stored row (the
 * marker depends on the value alone, so §5's byte-identical-prefix rule holds).
 */
const OPEN_SCALAR_MARKER =
    '(the Seed states nothing here — it is open, and the Writer may supply any detail that stays compatible with the Seed)';

const seedScalar = (name: string, value: string | undefined): string =>
    `${name}: ${value === undefined || value.trim().length === 0 ? OPEN_SCALAR_MARKER : value.trim()}`;

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
        seedScalar('logline', brief.logline),
        seedScalar('protagonist', brief.protagonist),
        seedScalar('want', brief.want)
    ];

    // `need` is optional: a brief that does not state it says so rather than looking truncated.
    if (brief.need !== undefined && brief.need.trim().length > 0) lines.push(`need: ${brief.need}`);

    lines.push(seedScalar('obstacle', brief.obstacle), seedScalar('stakes', brief.stakes), seedScalar('setting', brief.setting));
    lines.push(`world_rules:\n${bulletList(brief.world_rules)}`, seedScalar('promise', brief.promise));

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
 * in front of a Critic.
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
 * Every line below is optional except the header, and the order is FIXED (header, work, kind, defect,
 * evidence, criterion question, hint) so two compiles over the same rows are byte-identical (§5's cache
 * rule). `kind` is the T5 addition and appears ONLY on a row marked `proposal`, so a finding raised
 * before the field compiles exactly as it did before.
 */
export function renderFixTask(task: Task, finding?: Finding, criterion?: Criterion): string {
    const lines: string[] = [
        `[${task.id} · priority ${task.priority}${task.finding_ref === undefined ? '' : ` · ${task.finding_ref}`}] ${task.title}`
    ];

    // The task's own detail is the Editor's reading of the work (D-34 rewrote it into the Author's
    // surface); the finding's detail is the defect as the Critic saw it. Both travel: one says what
    // to do, the other says why, and a sample that only knows the first rewrites the wrong thing.
    if (task.detail !== undefined && task.detail.trim().length > 0) lines.push(`  work: ${task.detail.trim()}`);
    // T5: an approved PROPOSAL is a change the Writer is asked to make, not a break it is asked to
    // repair. The label has to be in the prompt because the fix task's `work:` line was copied from the
    // finding's defect wording, and a sample that reads "nothing pays the promise" re-drafts the
    // paragraph instead of writing the better one the Critic proposed.
    if (finding?.kind === 'proposal') lines.push('  kind: proposal (an improvement, not a defect)');
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
 * mid-round, and the screening verdict is graded against exactly the list the Critic was handed
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
    // pulling an unanswerable target into the Writer's contract and the Critic's panel.
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
 * T3 — the Seed-contract note appended to the SEED BRIEF section of BOTH compiled prompts.
 *
 * WHY HERE: §5's SEED BRIEF section is the one place a tool-less Writer sampler and a tool-less screening
 * Critic both read the Seed, and it is ENGINE-OWNED text — the role prompts either side of it are
 * Author-editable copies (§8), so a rule that lives only in the built-in template disappears the first
 * time the Author rewrites it. The note fixes the direction of the contract: the Brief commits what it
 * STATES, and everything it leaves silent is the Writer's to fill with any compatible specific. Before
 * this, the sampler's own template told it "an implication is legitimate, a new setting rule or
 * technology is not" — a permission narrower than the Author's intent, which then let Critics treat
 * every invented specific as an unkept promise.
 *
 * It costs ~470 characters of the shared prefix, and it is identical for every sample of a round, so
 * §5's cache argument is unaffected (nothing here reads a clock or an id).
 */
const SEED_CONTRACT_NOTE =
    '(The Seed Brief commits what it STATES; it is not an outline of everything the book must contain. Where it is silent, or a question is listed in `open_questions`, the Writer may supply any specific that stays compatible with it — an added place, consequence, stake or custom the Seed never named. That freedom is the job, not a defect: no pass may ask the Summary for foreshadowing, stakes or exhaustive detail that neither the Seed nor the Summary itself promised. A claim that CONTRADICTS the brief, or a commitment it states explicitly that the draft does not carry, is still the failure this level is graded on.)';

/**
 * The Seed section: the ACCEPTED Seed Brief when one exists, else the raw Seed with P5's note.
 * The fallback is load-bearing, not defensive noise — a Story whose Editor has not structured
 * the Seed yet must still compile (the dispatch gate refuses sampling, but a mis-ordered sweep
 * gets a truthful prompt instead of a crash).
 */
function seedSection(store: Store, storyId: string): { heading: string; body: string } {
    const brief = acceptedSeedBrief(store, storyId);

    // T3 — the contract note rides on BOTH shapes of the section, because both are read by a model that
    // has to decide whether an invention is allowed.
    if (brief !== undefined) return { heading: '## SEED BRIEF', body: `${renderSeedBrief(brief)}\n${SEED_CONTRACT_NOTE}` };

    const seed = storyOf(store, storyId)?.idea;

    return {
        heading: '## SEED',
        body: `${seed === undefined ? '(no Story row and no Seed Brief — there is nothing to sample from)' : seed}\n(no structured brief yet — the Seed itself is law, P5)\n${SEED_CONTRACT_NOTE}`
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
 * The screening Critic's one-turn prompt for ONE competing sample (§6.4 step 4).
 *
 * D-21 keeps the sibling samples out of a Critic's view, so the prompt names one draft's FIELDS
 * (never its revision id — ids are volatile and the prompt must be reproducible). The closing
 * instruction is the screening contract: critical/high only, verbatim quotes, `C-14`/`C-15`/`seed`
 * as the criteria, and an empty list as a legitimate answer.
 *
 * H1/R2 — when the candidate REPLACES a selected draft, the Critic is also handed the draft it replaces
 * and must judge the candidate against it; H2/R2 ties that section to the COMPARISON rather than to the
 * fix list, because the gate scores the same comparison whatever the queue looks like now. When the
 * round also carries fix rows, the Critic must answer for every fix by id (`fix_verifications`) — the
 * same run that ranks the round, not a second pipeline: the Critic that compares the two texts is the
 * one entitled to say whether the gap closed, and the engine gates the selection on its answer
 * (`sample-select.ts:scoreSample`). A round-1 screen has no accepted draft and so carries neither
 * section, so a clean first round costs exactly what it used to.
 */
export function compileScreenPrompt(
    store: Store,
    storyId: string,
    revisionId: string,
    opts: { fixRefs?: string[] } = {}
): CompiledPrompt {
    const system = `${rolePromptOf(store, SCREEN_TEMPLATE_SLUG, 'critic')}\n\n${outputContract(ISSUE_LIST_SCHEMA_NAME)}`;

    const sections: Array<{ heading: string; body: string }> = [seedSection(store, storyId)];

    const knowledge = knowledgeSection(store, storyId);

    if (knowledge !== undefined) sections.push(knowledge);

    const revision = revisionOf(store, revisionId);
    const fixes = renderFixTaskBlock(store, storyId, opts.fixRefs);

    // H2/R2 — the COMPARISON exists when the hill actually has an accepted Summary this candidate
    // replaces, which is what `sample-select.ts:scoreSample` asks (`records.ts:acceptedSummaryRevision`
    // reads the same rows). The old code asked "does this screen carry a fix list" instead, and those
    // two questions come apart: a queued list can empty out between arming and running, and then the
    // Critic was never shown the accepted draft while the gate still refused the candidate for every
    // issue the accepted draft did not already carry. So: SELECTED DRAFT + the origin rule ride on the
    // COMPARISON, and FIX TASKS + the verification rule ride on the fix list.
    const base = comparisonBaseOf(store, storyId, revision?.round ?? 1);

    // The sections that make a round-N screen a VERIFICATION rather than an opinion all sit before
    // TARGET DRAFT: every sample of the round shares those bytes, so the screening batch still reads
    // one cache prefix, and only the candidate differs (§5's argument applies to screens too).
    if (fixes !== '' || base !== undefined) {
        sections.push({
            heading: '## SELECTED DRAFT (the text the target draft below replaces — judge whether it was actually revised)',
            body:
                base === undefined
                    ? '(no selected Summary revision was found for the previous round — judge the target draft against the Seed, and mark every fix `unknown`)'
                    : renderSummaryBody(base.body)
        });
    }

    if (fixes !== '') {
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
        body: `${draft}\n\n${SCREEN_INSTRUCTION}${
            // The fix certificate is asked only of a screen that was handed fix rows; the origin rule
            // is asked of every screen that was handed the accepted draft (H2/R2 above).
            fixes === '' ? '' : `\n\n${FIX_VERIFICATION_INSTRUCTION}`
        }${base === undefined ? '' : `\n\n${ISSUE_ORIGIN_INSTRUCTION}`}`
    });

    const user = joinSections(sections);

    return { system, user, hash: hashPhase1Prompt(system, user) };
}

/**
 * The group Writer's one-turn prompt (Summary Phrase R2/R5).
 *
 * THE SHAPE, and why each section is where it is:
 *   - SEED BRIEF + KNOWLEDGE: unchanged from the sampler, because the facts a group is written from
 *     are the same facts and the Seed-contract note (`SEED_CONTRACT_NOTE`) is what stops a Writer
 *     treating a general Seed as an outline with unfilled boxes;
 *   - GROUPS: the groups this batch may write, each with its CURRENT text — a group revision is a
 *     revision of a specific text (R2), and handing the Writer only the fix tasks would have it
 *     rewrite a group it cannot see;
 *   - FIX TASKS: the approved work the batch was armed with, by id, exactly as a refinement round
 *     carried them. Present only when the batch carries tasks; a first draft is handed none, because
 *     there is nothing to answer yet and an empty heading reads as an unanswered demand.
 *
 * The `system` turn is the role prompt plus the answer contract for `GroupDraft` — group ids, group
 * count and round number never enter it, so two batches that share the state share the cacheable
 * prefix (§5). The template slug is the sampler's on purpose: the built-in role prompts are
 * Author-editable copies, and the rules that MUST hold (the exact-set answer, "content not
 * restatement", revise-don't-rewrite) are engine-owned text in `GROUP_DRAFT_INSTRUCTION`, so they
 * survive a rewrite of the template. The role's own voice is the prose the follow-up task owns.
 */
export function compileGroupDraftPrompt(
    store: Store,
    storyId: string,
    opts: { groupRefs: string[]; fixRefs?: string[] }
): CompiledPrompt {
    const system = `${rolePromptOf(store, SAMPLE_TEMPLATE_SLUG, 'writer')}\n\n${outputContract(GROUP_DRAFT_SCHEMA_NAME)}`;

    const sections: Array<{ heading: string; body: string }> = [seedSection(store, storyId)];

    const knowledge = knowledgeSection(store, storyId);

    if (knowledge !== undefined) sections.push(knowledge);

    const fixes = renderFixTaskBlock(store, storyId, opts.fixRefs);

    if (fixes !== '') {
        sections.push({
            heading: '## FIX TASKS (every one must be visible in the rewritten groups, by content, and each is judged by its id)',
            body: fixes
        });
    }

    sections.push({
        heading: '## GROUPS (the only groups this job may write — answer for every one of them)',
        body: `${renderGroupBlock(store, storyId, opts.groupRefs, { current: true })}\n\n${GROUP_DRAFT_INSTRUCTION}`
    });

    // PHRASE GROUP LOCK (R-lock) — the fixed point, SHOWN rather than assumed. A locked group is never in
    // the batch itself (`phrase/exclusion.ts:groupWorkTargets` subtracts locked groups), so without this
    // block the Writer would be revising four groups against a fifth it cannot see — and introducing a
    // contradiction with the signed-off section is precisely what the next review files as a finding,
    // which the redesign's per-group model would then chase for another round. It renders ONLY when the
    // book has a locked group, so an unlocked Story's bytes (and prompt hashes) are unchanged.
    //
    // WHY IT COMES AFTER `## GROUPS`: both halves of the answer are a question about the batch, and the
    // locked peers are context for it. The model reads its subject first and the note — "answer a FIX TASK
    // that names one of these sections in the unlocked groups you are being shown" — lands after the
    // groups it points at, which is the order the sentence is true in. It also keeps the prompt's FIRST
    // `group_ref=` a group this job can actually answer: the test rig resolves a concurrent sweep's prompt
    // to its Work Item by that token (`loop/mock.ts:groupJobOf`), and a locked peer printed above the batch
    // would name a group the batch does not carry. The Editor's own lock seat puts its candidate first for
    // the same reason.
    const lockedPeers = renderLockedPeerBlock(store, storyId);

    if (lockedPeers !== '') {
        sections.push({
            heading: '## LOCKED PEERS (signed-off sections this pass may NOT rewrite — the facts your groups must match)',
            body: lockedPeers
        });
    }

    const user = joinSections(sections);

    return { system, user, hash: hashPhase1Prompt(system, user) };
}

/**
 * The group review's one-turn prompt (Summary Phrase R3/R5).
 *
 * WHAT CHANGED from a screening pass, in one sentence: a screen judged one CANDIDATE against its
 * siblings before a winner was chosen; a group review judges the INSTALLED Overview, because in the
 * group model an accepted result is installed immediately and there is no competition to rank (R5).
 * So this prompt carries all FIVE groups (not one draft), each with its revision number — the
 * combination under review, which is also the key the job was claimed under — and the answer must
 * attribute every issue to the groups it is about.
 *
 * The FIX TASKS section rides only when the pass was handed tasks, and the fix-verification rule with
 * it: a pass that was given work to check is the only pass entitled to certify it, and the same
 * silence-is-not-a-pass grading as a screening row (`records.ts:sampleFixDemand`), so the group path
 * does not quietly invent a weaker evidence standard.
 */
export function compileGroupReviewPrompt(
    store: Store,
    storyId: string,
    opts: { groupRefs: string[]; fixRefs?: string[] }
): CompiledPrompt {
    const system = `${rolePromptOf(store, SCREEN_TEMPLATE_SLUG, 'critic')}\n\n${outputContract(GROUP_REVIEW_SCHEMA_NAME)}`;

    const sections: Array<{ heading: string; body: string }> = [seedSection(store, storyId)];

    const knowledge = knowledgeSection(store, storyId);

    if (knowledge !== undefined) sections.push(knowledge);

    const fixes = renderFixTaskBlock(store, storyId, opts.fixRefs);

    if (fixes !== '') {
        sections.push({
            heading: '## FIX TASKS (verify every one against the Overview below, by its id)',
            body: fixes
        });
    }

    // An empty group set is possible (a Story whose catalog has not been ensured yet) and is rendered
    // as such rather than as an empty section: a Critic that sees no groups must say so in its answer
    // rather than invent a defect to justify the pass.
    const overview = renderGroupBlock(store, storyId, opts.groupRefs, { current: true });

    sections.push({
        heading: '## OVERVIEW — the five groups as they stand (every issue names the groups it is about)',
        body: `${overview === '' ? '(this Story has no phrase groups yet — there is nothing installed to judge)' : overview}\n\n${SCREEN_INSTRUCTION}\n\n${GROUP_REVIEW_INSTRUCTION}${
            fixes === '' ? '' : `\n\n${FIX_VERIFICATION_INSTRUCTION}`
        }`
    });

    const user = joinSections(sections);

    return { system, user, hash: hashPhase1Prompt(system, user) };
}

/**
 * The section score's one-turn prompt (Reader scoring, D-65; reviewed gate, D-67).
 *
 * HOW IT DIFFERS FROM a group review, in one sentence: a review answers "what is wrong with this
 * Overview?" and its issues drive work; this answers "how good is each section right now?" and its
 * numbers drive NOTHING. So the prompt carries the five sections and no FIX TASKS section at all — a
 * pass that was shown the approved work would start grading it (`FIX_VERIFICATION_INSTRUCTION` would
 * have to come along), and a score that reacts to the queue rather than to the text is not the trend
 * the Author asked for.
 *
 * WHAT THE TEXT IS (D-67): the CLEAN SELECTION, not the installed Overview. `opts.vectorHash` is the
 * hash the seat claimed the job under (`phrase/exclusion.ts:sectionScoreVectorHashOf`), and it is the
 * hash the engine writes onto the score rows, so the compiler insists the bytes it renders belong to
 * that same selection — a Reader shown one Overview and recorded under another is a worse outcome than
 * a run that fails and re-arms. Two throws state it:
 *   - no complete clean selection: the gate that armed this seat has since gone (a finding arrived, or a
 *     scrap deleted the rows), so there is no reviewed Overview to score; and
 *   - a hash that is not the current selection's: a deep pass stamped a newer clean revision between the
 *     seat's claim and its dispatch. Refusing costs one attempt and the seat re-arms on the new hash
 *     (`loop/work.ts` candidate 2b); recording the old hash against new text would be a silent lie.
 *
 * The system turn is the reader's role prompt plus the answer contract, and it never names a group id,
 * a revision number or a vector, so two runs over shared state share the cacheable prefix (§5's rule,
 * applied unchanged). The user turn is the Seed, the critical/high Knowledge, and the five sections.
 */
export function compileSectionScorePrompt(
    store: Store,
    storyId: string,
    opts: { groupRefs: string[]; vectorHash: string }
): CompiledPrompt {
    const story = storyOf(store, storyId);

    if (story === undefined) throw new Error(`compileSectionScorePrompt: story ${storyId} does not exist`);

    const selection = cleanSelectionOf(store, story);

    if (!selection.complete) {
        throw new Error(
            `compileSectionScorePrompt: story ${storyId} has no reviewed Summary to score — ${selection.gaps
                .map((gap) => `${gap.group_key} (${gap.reason})`)
                .join(', ')} lacks a clean revision (D-67)`
        );
    }

    if (selection.vector_hash !== opts.vectorHash) {
        throw new Error(
            `compileSectionScorePrompt: story ${storyId}'s reviewed Summary moved from ${opts.vectorHash} to ` +
                `${selection.vector_hash} between the seat's claim and its dispatch (D-67)`
        );
    }

    const system = `${rolePromptOf(store, SCORE_TEMPLATE_SLUG, 'reader')}\n\n${outputContract(SECTION_SCORES_SCHEMA_NAME)}`;

    const sections: Array<{ heading: string; body: string }> = [seedSection(store, storyId)];

    const knowledge = knowledgeSection(store, storyId);

    if (knowledge !== undefined) sections.push(knowledge);

    // The reviewed map, keyed by group id, so `renderGroupBlock` can still walk CATALOG ORDER (one
    // state, one prompt — §5) while showing each group's SELECTED row. A group the selection names but
    // `groupRefs` omits simply never renders; the answer is refused at settlement for missing the group
    // anyway (`phrase/section-scores.ts`), exactly as it was before D-67.
    const reviewed = new Map<string, ReviewedCompositionEntry>();

    for (const entry of selection.entries) reviewed.set(entry.group.id, entry);

    const overview = renderGroupBlock(store, storyId, opts.groupRefs, { current: true, reviewed });

    sections.push({
        heading: '## REVIEWED OVERVIEW — every section, scored (name each group_ref exactly once)',
        // THE BLOCK IS THE PROMPT. `SECTION_SCORE_INSTRUCTION` below sends the Reader to "each group
        // printed above", to copy each `group_ref` "from the heading above", and to quote ONE `evidence`
        // line "verbatim from that section" — so the reviewed Overview has to be interpolated here, not
        // merely computed for the emptiness check. The rule sentence sits ABOVE the sections for the
        // reason §17.16 states: a Reader shown a superseded text must know it is the one the crew stands
        // behind, or it deducts for the newer prose it assumes is missing. An empty block stays the
        // stated empty case rather than a heading with nothing under it.
        body: `${
            overview === ''
                ? '(this Story has no phrase groups yet — there is nothing reviewed to score)'
                : `These are the sections the crew stands behind: the newest CLEAN revision of each group. A section may not be the newest text its group has written — it is the newest one a cross-group review passed, and it is the only text you are being asked to grade.\n\n${overview}`
        }\n\n${SECTION_SCORE_INSTRUCTION}`
    });

    const user = joinSections(sections);

    return { system, user, hash: hashPhase1Prompt(system, user) };
}

// ---------------------------------------------------------------------------
// PHRASE GROUP LOCK — the Editor's lock-review seat (R-lock, `editor_group_locking`)
// ---------------------------------------------------------------------------

/**
 * The template slug whose `editor` role prompt is the lock review's system turn.
 *
 * WHY A SLUG OF ITS OWN rather than reusing `editor-seed-structure`: that template's role prompt is a
 * script for a TOOL run ("call `structureSeed` once, then stop"), and a lock review has no tools and one
 * structured answer. The Author-editable copy for this slug says what an Editor weighing a sign-off
 * sounds like, and the catalogue DOES carry it: `templates.ts:BUILT_IN_TEMPLATES` ships
 * `builtIn('editor-group-lock')` (line 451) with the `editor` role's prompt, and
 * `templates.ts:DEFAULT_ASSIGNMENT` lists it (line 837) so the crew is visible and duplicate-able on the
 * Author's panel. So `rolePromptOf` resolves a real prompt for every engine-seeded Story, and
 * `fallbackRolePrompt` states the absence only for the §8 case an Author can actually create — deleting
 * the row or blanking its prompt — while `GROUP_LOCK_INSTRUCTION` below stays the whole binding contract
 * either way, which is exactly the division of labour §5 and R7 already draw for the Writer, the
 * reviewer and the Reader.
 */
export const GROUP_LOCK_TEMPLATE_SLUG = 'editor-group-lock';

/**
 * The lock seat's answer contract, stated once in engine-owned text.
 *
 * WHY THESE SENTENCES EXIST AT ALL: the Author's decision was Editor JUDGEMENT, not a numeric cutoff, and
 * a prompt that merely asked "lock it? yes/no" would produce a coin flip dressed as a decision — most
 * often "yes", because the seat only opens on a section a review already passed. So the text does four
 * things, each of them a failure mode:
 *   1. it says what `true` requires (no remaining issue AND no major improvement, both quotable), so the
 *      boolean carries a definition instead of a vibe;
 *   2. it forbids deciding on the number alone, in both directions (a high score with a seam quoted in
 *      its rationale is NOT a lock; a low score whose rationale names only taste is not automatically a
 *      refusal) — which is the whole reason the seat reads the rationale rather than the score;
 *   3. it names the COST asymmetry (a lock stops the crew repairing that section and closes every claim
 *      against it; only the Author can undo it), because a seat that feels free is the one that locks
 *      things by accident; and
 *   4. it makes `false` normal and unquotaed, so five honest refusals in a row read as a round rather
 *      than as a failure.
 * Deliberately absent: any threshold, any score arithmetic, and any instruction to grade the OTHER
 * sections — each has its own seat, and one pass collapsing five judgements into one is how a lock would
 * stop being a judgement about one section.
 */
const GROUP_LOCK_INSTRUCTION =
    'ANSWER FOR THE CANDIDATE SECTION ONLY, and decide one thing: is that section FINISHED? Copy its `group_ref` from the heading above into `group_ref`.\n' +
    '- `lock: true` is permitted only when BOTH halves below are supported by the evidence printed above, and you can point at the line that supports each:\n' +
    '  1. NO REMAINING ISSUE — every entry in OPEN CLAIMS that names this section is settled by words you can QUOTE from its text above, or is a note about sentences the chapters have not written yet (phase \u2462 writes those, and they are never a Summary defect). A claim you cannot quote your way out of is still open, and a claim still open means `lock: false`.\n' +
    '  2. NO MAJOR IMPROVEMENT IS MISSING — what the OPEN CLAIMS propose and what the Reader\u2019s `rationale` points at name nothing that would change what this section commits to, its own internal logic, or the way the other sections depend on it. A cosmetic change, a preference of yours, or a smoother sentence is not a reason to keep the loop rewriting this text; a missing commitment, a contradiction, or a seam the Reader quoted IS such a reason.\n' +
    '- The Reader\u2019s number is not the decision, and no number locks a section by itself. Weigh its REASON, and do not restate the number: 92 whose rationale names a seam is a section that still owes work, and 70 whose rationale names only a preference the Reader would personally have changed is not, on its own, a reason to withhold the lock. An answer that only repeats the score back is not a decision and will be refused.\n' +
    '- When you are UNSURE whether a claim is settled, answer `lock: false`. Locking is the strong move: it makes this section fixed text the whole crew must work around, every claim against it stops being work, and only the Author can undo it. Leaving it unlocked costs the book one more pass; locking it too early takes away the only way to repair it.\n' +
    '- `rationale` must be non-blank and must name what you weighed: the claim ids you considered (or \u201cno claim is open\u201d), and what in the section above settles each one. A decision with no reason behind it is refused (D-15).\n' +
    '- This pass decides ONE section. It may not lock or comment out another group, propose a rewrite, edit anything or file a finding: it has no tools, and the other sections have their own seats.';

/**
 * The locked-peer block, or `''` when nothing is locked (the caller then omits the section entirely, so a
 * book without a lock renders byte-identically to the way it did before the flag existed).
 *
 * The groups are rendered by {@link renderGroupBlock} in CATALOG ORDER with the same LOCKED marker the
 * heading carries, so a Writer, a reviewer and the Reader all see the identical sentence about what the
 * flag means — one branch in one renderer, three prompts.
 */
export function renderLockedPeerBlock(store: Store, storyId: string): string {
    const locked = phraseGroupsOf(store, storyId).filter(isPhraseGroupLocked);

    if (locked.length === 0) return '';

    return `${renderGroupBlock(store, storyId, locked.map((group) => group.id), { current: true })}\n\n${LOCKED_PEER_NOTE}`;
}

/** The sentence that rides under every LOCKED PEERS block. Engine-owned, for the reasons R7 states. */
const LOCKED_PEER_NOTE =
    'Every section above is LOCKED: the text is signed off, and neither this pass nor any later one can rewrite it (the engine refuses the whole batch that tries). Treat its facts as the facts your own sections have to agree with, and answer a FIX TASK that names one of these sections in the unlocked groups you are being shown, not in the locked text.';

/** Catalog key for a group id, falling back to the id when the row is gone (a scope must still print). */
const groupKeyOf = (store: Store, storyId: string): Map<string, string> =>
    new Map(phraseGroupsOf(store, storyId).map((group) => [group.id, group.key]));

/**
 * One claim (a `Finding` row) as the lock seat is shown it, in the same visual shape {@link renderFixTask}
 * prints for a Writer, so the model reads one format for "something someone says about this text".
 *
 * THE `about:` LINE IS THE LOAD-BEARING ONE: the scope is the DOMAIN read
 * (`phrase/findings.ts:findingGroupScope`), so an UNSCOPED legacy claim prints every group of the book —
 * which is what it means — instead of printing nothing and reading as "not about this section".
 */
function renderLockClaim(store: Store, story: Story, finding: Finding, targetGroupId: string): string {
    const keys = groupKeyOf(store, story.id);
    const scope = findingGroupScope(store, story, finding).refs;
    const named = scope.map((id) => keys.get(id) ?? id).join(', ');
    const lines = [
        `[${finding.id} \u00b7 ${finding.cost} \u00b7 ${finding.kind === 'proposal' ? 'proposal' : 'issue'} \u00b7 ${finding.state}] ${finding.title}`
    ];

    lines.push(
        `  about: ${named}${
            scope.includes(targetGroupId) ? ' \u2014 NAMES THIS SECTION' : ' \u2014 another section (context, not yours to answer)'
        }`
    );

    if (finding.detail !== undefined && finding.detail.trim().length > 0) lines.push(`  claim: ${finding.detail.trim()}`);
    if (finding.evidence.trim().length > 0) lines.push(`  evidence: ${finding.evidence.trim()}`);
    if (finding.criterion_ref.length > 0) lines.push(`  criterion: ${finding.criterion_ref}`);

    return lines.join('\n');
}

/** A bucket of claims, capped, with the stated remainder so a clipped block never reads as the whole truth. */
function renderLockClaimBlock(
    store: Store,
    story: Story,
    claims: readonly Finding[],
    targetGroupId: string,
    empty: string
): string {
    if (claims.length === 0) return empty;

    const shown = claims.slice(0, GROUP_LOCK_CLAIM_RENDER_CAP).map((finding) => renderLockClaim(store, story, finding, targetGroupId));

    if (claims.length <= GROUP_LOCK_CLAIM_RENDER_CAP) return shown.join('\n');

    return `${shown.join('\n')}\n(+${claims.length - GROUP_LOCK_CLAIM_RENDER_CAP} more of the same shape, oldest ids first, none of them changing the two questions above)`;
}

/**
 * The Editor's lock-review prompt (R-lock): one section, one judgement, one boolean.
 *
 * WHAT THE PASS IS SHOWN, and why each piece is there:
 *   - SEED BRIEF + KNOWLEDGE: the same shared prefix every phase-\u2460 compiled prompt opens with (§5),
 *     because "is this section finished?" is answered against what the book promised, not against taste;
 *   - CANDIDATE SECTION: the CLEAN revision of ONE group — the exact text the Reader scored, which is
 *     also the revision a lock would fix. Rendering the installed text instead would let the Editor
 *     approve a paragraph nobody reviewed;
 *   - THE READER'S READING: score + rationale + the quoted line, with the instruction's rule stated next
 *     to them. This is the ONLY place outside the score writer where a Reader row is read for a
 *     DECISION — the D-65 exception this seat exists to create, and it reads the rationale as evidence,
 *     never the number as a gate;
 *   - OPEN CLAIMS / CLAIMS ALREADY ANSWERED: the Critic's live issues and proposals (the "no major
 *     improvement" half) and the history that shows the earlier ones were paid;
 *   - LOCKED PEERS: the sections already fixed, with their text. A section is finished RELATIVE to those,
 *     and the unlocked peers are named so the Editor can see the loop still has somewhere to move.
 *
 * THE TWO THROWS mirror {@link compileSectionScorePrompt}: the seat's gate can go away between claim and
 * dispatch (a Setting switched off, a score row scrapped, a Writer holding the group, the selection
 * advancing), and a compiler that guessed would put a stale Overview in front of a model being asked to
 * freeze it. Refusing costs one attempt; the generator re-arms on the new state.
 */
export function compileGroupLockPrompt(
    store: Store,
    storyId: string,
    opts: { groupRef: string; vectorHash: string }
): CompiledPrompt {
    const story = storyOf(store, storyId);

    if (story === undefined) throw new Error(`compileGroupLockPrompt: story ${storyId} does not exist`);

    const selection = cleanSelectionOf(store, story);
    const evidence = editorLockEvidenceOf(store, story, opts.groupRef, selection);

    if (evidence === undefined) {
        const gap = selection.gaps.map((entry) => `${entry.group_key} (${entry.reason})`).join(', ');

        throw new Error(
            `compileGroupLockPrompt: ${opts.groupRef} is not lockable by the Editor right now — story ${storyId} needs \`editor_group_locking\` on, a COMPLETE reviewed Summary whose entry for this group is its current text${
                gap === '' ? '' : ` (gaps: ${gap})`
            }, a Reader score for this group at that exact vector, and no live Writer over it (R-lock)`
        );
    }

    if (evidence.vector_hash !== opts.vectorHash) {
        throw new Error(
            `compileGroupLockPrompt: story ${storyId}'s reviewed Summary moved from ${opts.vectorHash} to ${evidence.vector_hash} between the seat's claim and its dispatch (R-lock)`
        );
    }

    const system = `${rolePromptOf(store, GROUP_LOCK_TEMPLATE_SLUG, 'editor')}\n\n${outputContract(GROUP_LOCK_SCHEMA_NAME)}`;

    const sections: Array<{ heading: string; body: string }> = [seedSection(store, storyId)];

    const knowledge = knowledgeSection(store, storyId);

    if (knowledge !== undefined) sections.push(knowledge);

    // The reviewed map, keyed by group id, so `renderGroupBlock` still walks CATALOG ORDER while showing
    // the CLEAN rows (D-67's rule, applied unchanged to a seat that grades exactly one of them).
    const reviewed = new Map<string, ReviewedCompositionEntry>();

    for (const entry of selection.entries) reviewed.set(entry.group.id, entry);

    const candidate = renderGroupBlock(store, storyId, [evidence.group.id], { current: true, reviewed });

    sections.push({
        heading: `## CANDIDATE SECTION \u2014 the one section this pass may lock (clean revision ${evidence.revision.number} of the reviewed Overview, vector ${evidence.vector_hash})`,
        body: `This is the exact text the Reader scored: the newest CLEAN revision of this group, the one a cross-group review passed. It is also the revision a lock would fix, so judge THESE words and no others.\n\n${candidate}`
    });

    sections.push({
        heading: '## THE READER\u2019S READING (the number AND the reason for it \u2014 weigh the reason)',
        body: `score: ${evidence.score.score}/100
rationale: ${evidence.score.rationale}
evidence: ${evidence.score.evidence}
vector: ${evidence.score.vector_hash}${evidence.score.vector_hash === evidence.vector_hash ? ' (the same vector this seat is about)' : ''}
run: ${evidence.score.run_ref}

This is one Reader's reading of one section, not a rule and not a verdict. What you are being asked to weigh is the \`rationale\`: the Reader's own sentence about why the section holds or does not, and the line it quoted. A rationale that points at a seam you can find in the text above is a live claim; a rationale that names only something the Reader would personally have phrased differently is a taste, and a taste is not a defect at this phase.`
    });

    sections.push({
        heading: '## OPEN CLAIMS (every unresolved issue and proposal against this section or the fixed point \u2014 this is what \u201cno remaining issue\u201d is judged against)',
        body: renderLockClaimBlock(
            store,
            story,
            evidence.open_claims,
            evidence.group.id,
            '(no unresolved claim names this section or any locked one \u2014 nothing is currently asking this text to change)'
        )
    });

    sections.push({
        heading: '## CLAIMS THIS SECTION HAS ALREADY ANSWERED (closed rows, for context only \u2014 an answered claim is not a reason to keep rewriting)',
        body: renderLockClaimBlock(
            store,
            story,
            evidence.closed_claims,
            evidence.group.id,
            '(none \u2014 no closed claim names this section)'
        )
    });

    sections.push({
        heading: '## LOCKED PEERS (sections already signed off \u2014 the fixed point this section is finished RELATIVE to)',
        // The block is rendered by the same helper the Writer's prompt uses, so the marker sentence is the
        // same sentence in every prompt (one branch, one meaning). With no locked peer the seat is the
        // first lock the book would take, which is worth saying: this section then becomes the baseline.
        body: `${renderLockedPeerBlock(store, storyId) === ''
            ? '(no other section is locked yet \u2014 locking this one would make it the first fixed point the rest of the Overview is revised against)'
            : renderLockedPeerBlock(store, storyId)}
the sections still unlocked, which keep being rewritten whichever way you answer: ${
            evidence.unlocked_peers.length === 0
                ? '(none \u2014 every other section is already locked or is this one)'
                : evidence.unlocked_peers.map((group) => group.key).join(', ')
        }`
    });

    sections.push({ heading: '## LOCK DECISION (the only answer this pass may give)', body: GROUP_LOCK_INSTRUCTION });

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
