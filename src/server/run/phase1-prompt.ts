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

import {
    GROUP_DRAFT_SCHEMA_NAME,
    GROUP_REVIEW_SCHEMA_NAME,
    ISSUE_LIST_SCHEMA_NAME,
    SUMMARY_SAMPLE_SCHEMA_NAME
} from '../../shared/schemas';
// SUMMARY PHRASE: the group rows, their catalog definitions, and their current texts. `server/phrase`
// imports nothing from the run layer, so this adds no cycle.
import { phraseGroupsOf } from '../phrase';
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
// scores a refinement against, and `compileScreenPrompt` must show the Reader that same text.
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
 *
 * T3 — the SECOND half of the same calibration, and the half that still cost rounds. The line below
 * used to read "A high fails to deliver something the Seed Brief promises", which let a screening
 * Reader treat a general Seed as an outline with unfilled boxes. Two of the Author's screenshots are
 * exactly that: a `UNCONFIRMED` note because the final hedgerow refuge appears only in the ending and
 * had no earlier planting in the Summary, and an `APPROVED` one because the Summary never says what
 * the bird loses if the search fails — a stake the Seed left open. Both are inventions the Writer is
 * allowed to make. Screening has no Editor or Reader pass downstream to dispute them either: its
 * issues rank the round on the spot (§6.5), so the rule lives in this ENGINE-OWNED text, not only in
 * the Author-editable `reader-screening` role prompt (a custom template replaces the system turn).
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
 * HILL CLIMB — the ORIGIN rule, asked of every screen that was handed the ACCEPTED draft, and in the
 * same section as the candidate because it is the same comparison: the Reader has the accepted draft
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
    '- Breaking something the base draft got right is a NEW defect: the readers compare your draft with ' +
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
     '- Your own word that a defect is gone proves nothing: the next review decides, by quoting the installed group that shows the repair. Answer the whole defect in every group it names, or claim nothing.\n' +
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
    'One defect that crosses several groups is ONE issue naming every group it crosses — never one issue per group, which would buy several rewrites of the same complaint. Say in `location` which group your `quote` came from and where in it the line sits: ids and headings are the address the Writer revises, prose summaries of the book are not. When the prompt carries FIX TASKS, a task whose finding names several groups is `resolved` only once EVERY one of those groups carries the repair — one group fixed is not the finding fixed. And this pass writes nothing: it spends none of the Story\u2019s rewrite allowance, so report what you find without rationing.';

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
function renderGroupEntry(store: Store, group: PhraseGroup, options: { current: boolean }): string {
    const definition = phraseGroupDefinition(group.key);
    const title = definition?.title ?? group.title;
    const description = definition?.description ?? group.description;
    const lines = [`### ${title} (group_ref=${group.id}, key=${group.key}, revision=${group.revision})`, description];

    if (!options.current) return lines.join('\n');

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
    options: { current: boolean }
): string {
    const wanted = new Set(groupRefs);

    return phraseGroupsOf(store, storyId)
        .filter((group) => wanted.size === 0 || wanted.has(group.id))
        .map((group) => renderGroupEntry(store, group, options))
        .join('\n\n');
}

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
 * The accepted Summary a candidate REPLACES — the text a round-N screen verifies AGAINST.
 *
 * Two reads, in priority order: the Summary `selectRevision` selected at the previous round (the row
 * the Writer was itself handed as `base_ref`, so Writer and Reader must see the same text), then
 * `loop/records.ts:acceptedSummaryRevision` — the row the SELECTION gate scores against. Under H1 a
 * round advances only by installing a certified draft, so the two agree; the fallback is what keeps
 * the prompt honest (and the origin rule asked) if the hill ever advances without installing, instead
 * of leaving the Reader blind while the gate still refuses the candidate for every issue the accepted
 * draft does not already carry. If those two reads ever disagree, the Reader is grading a different
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
 * One scalar Seed Brief field, or the stated absence.
 *
 * `stakes`/`obstacle`/`setting` and friends are REQUIRED on the record, so a brief whose Seed left
 * them open still carries the key — and it rendered as `stakes: ` with nothing after it. A Reader
 * reads a blank field as an unpaid promise, which is the exact complaint the Author reported ("the
 * Summary never says what the bird loses"): the Seed left the stake open, the Editor recorded that in
 * `open_questions` as its instructions require, and the blank line in front of the Reader looked like
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
 * Every line below is optional except the header, and the order is FIXED (header, work, kind, defect,
 * evidence, criterion question, hint) so two compiles over the same rows are byte-identical (§5's cache
 * rule). `kind` is the T5 addition and appears ONLY on a row marked `improvement`, so a finding raised
 * before the field compiles exactly as it did before.
 */
export function renderFixTask(task: Task, finding?: Finding, criterion?: Criterion): string {
    const lines: string[] = [
        `[${task.id} · priority ${task.priority}${task.finding_ref === undefined ? '' : ` · ${task.finding_ref}`}] ${task.title}`
    ];

    // The task's own detail is the Editor's reading of the work (D-34 rewrote it into the Author's
    // surface); the finding's detail is the defect as the Reader saw it. Both travel: one says what
    // to do, the other says why, and a sample that only knows the first rewrites the wrong thing.
    if (task.detail !== undefined && task.detail.trim().length > 0) lines.push(`  work: ${task.detail.trim()}`);
    // T5: an approved IMPROVEMENT is a change the Writer is asked to make, not a break it is asked to
    // repair. The label has to be in the prompt because the fix task's `work:` line was copied from the
    // finding's defect wording, and a sample that reads "nothing pays the promise" re-drafts the
    // paragraph instead of writing the better one the Reader proposed.
    if (finding?.kind === 'improvement') lines.push('  kind: improvement (a proposal, not a defect)');
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
 * T3 — the Seed-contract note appended to the SEED BRIEF section of BOTH compiled prompts.
 *
 * WHY HERE: §5's SEED BRIEF section is the one place a tool-less Writer sampler and a tool-less screening
 * Reader both read the Seed, and it is ENGINE-OWNED text — the role prompts either side of it are
 * Author-editable copies (§8), so a rule that lives only in the built-in template disappears the first
 * time the Author rewrites it. The note fixes the direction of the contract: the Brief commits what it
 * STATES, and everything it leaves silent is the Writer's to fill with any compatible specific. Before
 * this, the sampler's own template told it "an implication is legitimate, a new setting rule or
 * technology is not" — a permission narrower than the Author's intent, which then let Readers treat
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
 * The screening Reader's one-turn prompt for ONE competing sample (§6.4 step 4).
 *
 * D-21 keeps the sibling samples out of a Reader's view, so the prompt names one draft's FIELDS
 * (never its revision id — ids are volatile and the prompt must be reproducible). The closing
 * instruction is the screening contract: critical/high only, verbatim quotes, `C-14`/`C-15`/`seed`
 * as the criteria, and an empty list as a legitimate answer.
 *
 * H1/R2 — when the candidate REPLACES a selected draft, the Reader is also handed the draft it replaces
 * and must judge the candidate against it; H2/R2 ties that section to the COMPARISON rather than to the
 * fix list, because the gate scores the same comparison whatever the queue looks like now. When the
 * round also carries fix rows, the Reader must answer for every fix by id (`fix_verifications`) — the
 * same run that ranks the round, not a second pipeline: the Reader that compares the two texts is the
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
    const system = `${rolePromptOf(store, SCREEN_TEMPLATE_SLUG, 'reader')}\n\n${outputContract(ISSUE_LIST_SCHEMA_NAME)}`;

    const sections: Array<{ heading: string; body: string }> = [seedSection(store, storyId)];

    const knowledge = knowledgeSection(store, storyId);

    if (knowledge !== undefined) sections.push(knowledge);

    const revision = revisionOf(store, revisionId);
    const fixes = renderFixTaskBlock(store, storyId, opts.fixRefs);

    // H2/R2 — the COMPARISON exists when the hill actually has an accepted Summary this candidate
    // replaces, which is what `sample-select.ts:scoreSample` asks (`records.ts:acceptedSummaryRevision`
    // reads the same rows). The old code asked "does this screen carry a fix list" instead, and those
    // two questions come apart: a queued list can empty out between arming and running, and then the
    // Reader was never shown the accepted draft while the gate still refused the candidate for every
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
    const system = `${rolePromptOf(store, SCREEN_TEMPLATE_SLUG, 'reader')}\n\n${outputContract(GROUP_REVIEW_SCHEMA_NAME)}`;

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
    // as such rather than as an empty section: a Reader that sees no groups must say so in its answer
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
 * The prompt hash §5 pins: sha256 over `system + '\n\n--phase1--\n\n' + user`, first 16 hex chars.
 * The separator is fixed text rather than a concatenation, so no two pairs (system, user) can
 * collide by shifting a boundary. Exported because the executor and the loop's settlement step
 * both need to name a prompt without recompiling it.
 */
export function hashPhase1Prompt(system: string, user: string): string {
    return createHash('sha256').update(`${system}\n\n--phase1--\n\n${user}`, 'utf8').digest('hex').slice(0, 16);
}
