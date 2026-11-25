// PHRASE ① SUMMARY — the Summary Phrase's controller (the original phrase, now one instance of the shape).
//
// WHAT THIS MODULE IS: everything the loop used to hard-code about the Summary Phrase, expressed as
// answers to the questions `../controller.ts` asks, so the Summary stops being the unnamed default that
// every phrase-shaped read secretly assumed. It changes no behaviour: every hook here resolves to the
// same function the loop already called, with the same arguments, and the claim-key ref is still the
// `summaries` row id for exactly the reason seam S8 gives (a persisted `wi_draft_groups_<summaryRef>_…`
// key must survive this change byte for byte, or a restart re-buys every draft pass it already ran).
//
// WHY IT IS AN OBJECT AND NOT A SUBCLASS: the Summary overrides nothing, because there is nothing to
// override — the shared engine (`revisions.ts`, `exclusion.ts`, `findings.ts`) is the base class, and it
// is shared by being CALLED, not by being extended.

import { PHRASE_SUMMARY_KEY, phraseDefinition, type PhraseDefinition } from '../../../shared/phrase';
import { GROUP_DRAFT_SCHEMA_NAME, GroupDraftSchema } from '../../../shared/schemas';
import type { Phrase, PhraseGroup, Story } from '../../../shared/types';
import type { Attribution, Store } from '../../store';
import type { PhraseController, PhraseInstructionSet, PhraseStartOptions, PhraseStartResult } from '../controller';
import { ensurePhraseCatalog, isGroupManagedStory, phraseGroupsOf, storyPhrase } from '../catalog';
import { installGroupRevisions, parseGroupDraftAnswer, type GroupInstallEntry, type GroupInstallOptions } from '../revisions';
import type { PlotpointFields } from '../plotpoints';

/** The catalog entry this controller is bound to. The catalog is the source; `!` is a wiring assertion. */
const DEFINITION = phraseDefinition(PHRASE_SUMMARY_KEY) as PhraseDefinition;

/**
 * The `summaries` row id — the ref the Summary draft claim family has always embedded.
 *
 * `loop/work.ts:phase1GroupCandidates` builds `wi_draft_groups_<summaryRef>_<group-set hash>_<attempt>`
 * from `storySummary(store, story.id)?.id`, and the exclusion recognises the family off a persisted
 * `work_item_ref` alone. So this hook returning anything else would re-key every Summary draft claim on
 * every existing book, and a restart would re-dispatch work it had already done (L-2/L-3).
 */
const summaryClaimRefOf = (store: Store, story: Story): string =>
    store.summaries.list().find((row) => row.story_id === story.id)?.id ?? '';

// ---------------------------------------------------------------------------------------------
// The engine-owned instruction slots for Phrase ①'s passes.
//
// WHY THESE RESTATE, RATHER THAN IMPORT, `run/phase1-prompt.ts`'s constants: `run/**` imports
// `phrase/**`, so importing back would put a cycle between the prompt compiler and the domain it
// compiles prompts for. The AUTHORITATIVE compiled text today is still
// `run/phase1-prompt.ts:GROUP_DRAFT_INSTRUCTION` / `GROUP_REVIEW_INSTRUCTION` /
// `SECTION_SCORE_INSTRUCTION`; these slots are the phrase-scoped statement of the same rules, placed
// where a phrase-generic caller can reach them, and the prompt wave that wires the compiler has to
// pick ONE home and delete the other. Keeping both is the drift risk this note exists to name.
// ---------------------------------------------------------------------------------------------

const SUMMARY_DRAFT_INSTRUCTION =
    'Answer with one `groups` entry for EVERY group the job named and for NO other group: `group_ref` is exactly the id in that ' +
    'heading, and `content` is that group\u2019s COMPLETE text \u2014 not a diff and not a note about it. A group the job did not name ' +
    'is not yours to rewrite, a group twice is an ambiguous batch, and a group it named that you leave out fails the whole batch: ' +
    'the engine installs an answer for all the named groups or for none.\n' +
    '- Where a group already has a current text, REVISE it. Change what the fix tasks require and the coordinated minimum around ' +
    'it; keep every other commitment it makes, because the other groups are being read against those facts right now.\n' +
    '- Breaking a fact another group depends on is a new defect: the reviewers read all five groups together, and your own word ' +
    'that a defect is gone proves nothing \u2014 the next review decides by quoting the installed group that shows the repair.\n' +
    '- A group marked `LOCKED` is signed-off, fixed text: never answer for one, and treat the facts it states as facts your own ' +
    'groups must match.';

const SUMMARY_REVIEW_INSTRUCTION =
    'EVERY issue names its `group_refs`, from the ids the OVERVIEW section printed. Name the one group the defect is in, or ' +
    'several \u2014 all five \u2014 when the defect is in how they fit together: a promise the Ending does not keep, a Theme the ' +
    'Premise never grounds. An issue that cannot name a group is not an answer this pass may give, because the loop routes work by ' +
    'group and a defect with no group is work nobody can do.\n' +
    'One defect crossing several groups is ONE issue naming every group it crosses, never one issue per group. Say in `location` ' +
    'which group your `quote` came from. A group the OVERVIEW marks `LOCKED` is the BASELINE: put the change where change is still ' +
    'possible and name the UNLOCKED group that has to move. This pass writes nothing.';

const SUMMARY_SCORE_INSTRUCTION =
    'SCORE EVERY SECTION ONCE, a whole number from 0 to 100, answering one question: how well does this section hold up as ' +
    'written \u2014 its own internal logic, its consistency with the other sections, and the plausibility of what it asserts? Anchor ' +
    'the ends: 100 is a section nothing in the Overview contradicts, 70 is sound with a seam you can point at, 40 fights its ' +
    'neighbours, 10 contradicts itself. Do not deduct for detail the Seed never promised or for prose the chapters have not ' +
    'written yet. Name every group exactly once, with one `rationale` and one verbatim `evidence` line. This pass reports a ' +
    'number: it files no finding, opens no task, and edits nothing.';

const SUMMARY_LOCK_INSTRUCTION =
    'A group is lockable when the judgement about it is EXHAUSTED rather than merely good: the Critic\u2019s findings on it are spent ' +
    '(no issues left, or no major improvement left to buy) and the Reader\u2019s score and rationale say the text is doing its job. ' +
    'Locking makes that text the fixed point the OTHER groups are revised against for consistency, so the recommendation has to say ' +
    'what would still have to change elsewhere if it is locked. The Editor may not unlock, and on a Story that has not enabled ' +
    'editor locking it may not lock at all.';

/** PHRASE ① as a controller: the dial, the rows, the answer contract, the install, the claim ref, the prompts. */
export const summaryPhraseController: PhraseController = {
    key: PHRASE_SUMMARY_KEY,
    definition: DEFINITION,

    isManaged: (story) => isGroupManagedStory(story),

    phraseOf: (store, storyId) => storyPhrase(store, storyId),

    groupsOf: (store, storyId, phraseId) => phraseGroupsOf(store, storyId, phraseId),

    // Phrase ①'s "start" IS the story-creation ensure: its seed is `stories.idea`, which the Story already
    // has, so there is no text to hand in and no moment at which the phrase cannot exist. The row and the
    // five groups are one idempotent ensure, and `started` reports whether THIS call minted the row.
    start: (store, story, attribution, options: PhraseStartOptions = {}): PhraseStartResult => {
        const ensured = ensurePhraseCatalog(store, story, attribution, { newId: options.newId });

        if (ensured === undefined) {
            throw new Error(
                `summaryPhraseController.start: the catalog has no definition that starts with the Story, so the Summary Phrase row cannot be created for story ${story.id}`
            );
        }

        return { phrase: ensured.phrase, started: ensured.created_phrase };
    },

    // The Summary's entry set is the catalog's five groups, so `entryCount` is ignored and the same
    // idempotent ensure is the whole answer. `ensurePhraseCatalog` is what already keeps a second call
    // silent, which is the property the loop's restart path depends on.
    ensureGroups: (store, story, phrase, _entryCount, attribution, options = {}) =>
        ensurePhraseCatalog(store, story, attribution, { newId: options.newId })?.groups ??
        phraseGroupsOf(store, story.id, phrase.id),

    answer: { name: GROUP_DRAFT_SCHEMA_NAME, schema: GroupDraftSchema },

    parseDraft: (store, story, requestedGroupRefs, structured, phraseId) => {
        const decision = parseGroupDraftAnswer(
            store,
            story.id,
            requestedGroupRefs,
            structured,
            phraseId ?? storyPhrase(store, story.id)?.id
        );

        // `GroupDraftDecision.contents` is already a `{group, content}` list; the Summary's answer carries
        // no plotpoints because a Summary group's text IS its answer.
        return decision;
    },

    install: (store, story, entries, attribution, options) =>
        installGroupRevisions(store, story, entries, attribution, options),

    // The Summary's entry text is the prose the Writer answered, trimmed once at the boundary so the
    // group row, the revision row and the legacy mirror all hold the same bytes.
    composeEntryContent: (_group, _fields, prose) => (typeof prose === 'string' ? prose.trim() : ''),

    draftClaimRef: (store, story) => summaryClaimRefOf(store, story),

    instructions: {
        draft: SUMMARY_DRAFT_INSTRUCTION,
        review: SUMMARY_REVIEW_INSTRUCTION,
        score: SUMMARY_SCORE_INSTRUCTION,
        lock: SUMMARY_LOCK_INSTRUCTION
    }
};
