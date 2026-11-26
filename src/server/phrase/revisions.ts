// SUMMARY PHRASE — the install, the archive, and the legacy mirror (R2, R5, R6).
//
// WHAT THIS MODULE IS: the one place a group's text becomes a fact in the book. R5 removed the
// whole-Summary draft competition from this path — an accepted Writer result is installed
// IMMEDIATELY and what it replaced is ARCHIVED — so there is no selector here, no scoring, and no
// truncation. What is here instead is a very small number of decisions that all have to hold
// TOGETHER, in one commit, or the book is internally inconsistent:
//
//   1. one new `group_revisions` row per written group, numbered from that group's own line (R2);
//   2. the previous latest of THAT group flipped to `archived` — retained, hidden from the latest
//      view (R2). A group nobody wrote gets no revision row, so an untouched group's history is
//      literally unchanged: this is the clause that makes "one group write never revises its
//      siblings" provable rather than intended;
//   3. the group row's `content`/`revision` set to the new text;
//   4. the phrase row's Overview recomposed and its `revision` bumped ONCE per install (not once
//      per group — the phrase number counts installs, the group numbers count group texts);
//   5. the phrase's DOWNSTREAM SYNC, in the SAME commit: for the Summary Phrase that is the legacy
//      `summaries` mirror (R6), and for the Plotlines Phrase it is the chapter's `plotlines` contract
//      row. Either way no reader — the Dashboard, the Digest, the criteria engine, phases ②/③ — can
//      ever see a new entry text beside an old synced record or the reverse. WHICH sync runs is an
//      explicit branch on the phrase row's kind, chosen before the first write, and an unknown kind
//      refuses the batch instead of syncing nothing (seam S3).
//
// WHY VALIDATION RUNS BEFORE THE FIRST WRITE: a batch that answers for a group it was not asked
// for, or skips one it was, must be refused WHOLE. Writing three of four groups and then noticing
// the fourth is missing would install a partial batch, spend the R4 exclusion for the whole set,
// and leave the Author's Overview half-revised with no journal line saying the batch was rejected.
// So every check below is a pure read, and the write section that follows has no `if` left in it.
import { createHash } from 'node:crypto';

import {
    PHRASE_PLOTLINES_KEY,
    PHRASE_SUMMARY_KEY,
    SUMMARY_MIRROR_FIELDS,
    phraseGroupRankOf,
    type SummaryMirrorField
} from '../../shared/phrase';
import type {
    GroupDraft,
    GroupReview,
    GroupReviewIssue
} from '../../shared/schemas';
import type { GroupRevision, Phrase, PhraseGroup, Story, Summary } from '../../shared/types';
import type { Attribution, Store } from '../store';
import {
    composeGroupContentFrom,
    isPhraseGroupLocked,
    phraseGroupsOf,
    primaryPhraseOf,
    storyPhrase
} from './catalog';
// PHRASE ②'s phrase-specific install work lives in `plotpoints.ts` rather than inline here. That module
// imports NOTHING from `phrase/**`, so the install can call it without an import cycle, and the one
// thing it must not become is a second copy of the composition rule.
import { syncPlotlineContract, type PlotpointFields } from './plotpoints';

// ---------------------------------------------------------------------------
// Reads — the current text, the history, and the review vector
// ---------------------------------------------------------------------------

/**
 * The `latest` revision row of one group, or `undefined` while the group has never been written.
 *
 * Read from the revision rows rather than from `PhraseGroup.revision` because the revision row is
 * the single source of the latest/archived position (the group row's number is a denormalised copy
 * for cheap reads); if the two ever disagree, THIS read is what the install and the projection
 * follow, and the disagreement is a bug in the install, not a choice to paper over.
 */
export function latestGroupRevision(store: Store, groupId: string): GroupRevision | undefined {
    return store.groupRevisions
        .list()
        .filter((revision) => revision.group_id === groupId && revision.state === 'latest')
        .sort((left, right) => right.number - left.number)[0];
}

/**
 * One group's revision history, NEWEST FIRST, including the latest row.
 *
 * R6 asks for the archived history server-side (the projection lists it separately and never in
 * place of the current text), and "newest first" is the shape an Author's rail renders without a
 * second sort. Nothing is filtered out: an archived row is retained history (R2), and a reader who
 * asks for the history gets all of it, including the row that is currently `latest`.
 */
export function groupRevisionHistory(store: Store, groupId: string): GroupRevision[] {
    return store.groupRevisions
        .list()
        .filter((revision) => revision.group_id === groupId)
        .sort((left, right) => right.number - left.number || left.id.localeCompare(right.id));
}

/**
 * The CURRENT revision vector of ONE phrase: `group id -> its latest revision number`, for every entry
 * of the phrase (an unwritten entry is `0`).
 *
 * This is what a cross-entry review is KEYED by. A review of the Overview is a review of a specific
 * combination of texts, and the combination — not a draft id — is what has to be stable across
 * a restart: the same vector yields the same claim key, so a restarted loop neither re-buys a review
 * it already ran nor mistakes a new combination for one it read before (L-2/L-3).
 *
 * `phraseId` is optional and DEFAULTS TO THE STORY'S PRIMARY PHRASE (seam S5): the vector is a
 * phrase-level identity — a Summary review and a cross-chapter review are different combinations of
 * different rows, and a hash that mixed them would re-arm one phrase when the other moved. The default
 * keeps every pre-Phrase-② call site answering what it always answered.
 */
export function groupRevisionVector(store: Store, storyId: string, phraseId?: string): Record<string, number> {
    const vector: Record<string, number> = {};
    const scoped = phraseId ?? primaryPhraseOf(store, storyId)?.id;

    for (const group of phraseGroupsOf(store, storyId, scoped)) vector[group.id] = group.revision;

    return vector;
}

/**
 * A stable 16-hex hash of a revision vector: one `<group id>:<number>` pair per group, sorted, joined
 * with `|`, then SHA-256 truncated to 16 hex characters.
 *
 * WHY A HASH OF THE VECTOR RATHER THAN OF ONE TEXT: the group model's review state is a fact about the
 * COMBINATION of five current texts (R3's cross-group defects are exactly the ones no single group
 * carries), so the review seats and the deep review claim-key on the vector — an install moves one
 * number, which re-arms the seats by themselves, and a group whose text did not move leaves the hash
 * alone. It is order-independent by construction because the pairs are sorted before hashing, which
 * matters: `Object.entries` returns insertion order, and a hydrating store does not guarantee one.
 *
 * The hash is deliberately NOT keyed by the catalog key: `groupRevisionVector` is keyed by the
 * persisted group id (the address a finding and a run row also name), so the hash reproduces from the
 * rows alone, without the catalog, on a book whose group keys were retitled or retired.
 */
export function groupVectorHash(vector: Readonly<Record<string, number>>): string {
    const parts = Object.entries(vector)
        // `${id}:${number}` sorts deterministically; `Object.entries` order is insertion order, which
        // a hydrating store does not guarantee, so the sort is not cosmetic.
        .map(([groupId, number]) => `${groupId}:${number}`)
        .sort();

    return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// The Writer's answer, validated against the JOB rather than against the schema
// ---------------------------------------------------------------------------

/** A batch that passed every check: the texts by group id, in the order the catalog composes them. */
export interface GroupDraftDecision {
    ok: true;
    /** `group id -> the text to install`, ordered by catalog rank so an install is deterministic. */
    contents: Array<{ group: PhraseGroup; content: string }>;
    knowledgeUsed: string[];
}

/** A batch refused before any row moved. `refusal` is a sentence for the log and the next attempt. */
export interface GroupDraftRefusal {
    ok: false;
    refusal: string;
}

/**
 * Validates one `GroupDraft` answer against the group set the JOB named (R2's atomicity rule).
 *
 * The transport already ran the JSON Schema (shape, non-empty strings, closed properties —
 * `shared/schemas/group-draft.ts`). What the schema CANNOT know is the job: which groups were
 * asked for. Those are the rules here, and they are checked in a fixed order so a refusal says the
 * most actionable thing first:
 *
 *   - a `group_ref` that is not one of this Story's groups (an invented id, or a catalog key like
 *     `premise` used as an address) — refused, because writing to a group the job never named would
 *     revise an untouched group (R2) and because an id the book does not have cannot be audited;
 *   - a DUPLICATE `group_ref` — refused: two texts for one group is not two revisions, it is an
 *     ambiguous one, and choosing the first would be a silent decision the loop is not entitled to;
 *   - a group the job NAMED but the answer SKIPPED — refused: a partial install would leave the
 *     Author's Overview half-revised and the exclusion spent for a batch that never finished;
 *   - a group the answer wrote that the job did NOT name — refused for the same reason as the first.
 *
 * It never repairs an answer (no "drop the unknown group and keep the rest"): a repair is a decision
 * about the Author's text, and the loop's own rule about that is to fail closed and try again.
 */
export function parseGroupDraftAnswer(
    store: Store,
    storyId: string,
    requestedGroupRefs: readonly string[],
    structured: unknown,
    phraseId?: string
): GroupDraftDecision | GroupDraftRefusal {
    const answer = structured as GroupDraft | undefined;
    const rows = Array.isArray(answer?.groups) ? answer.groups : undefined;

    if (rows === undefined || rows.length === 0) {
        return { ok: false, refusal: 'the GroupDraft answer carried no `groups` entries' };
    }

    // THE PHRASE THE JOB BELONGS TO (seams S5/S12). `requestedGroupRefs` already carries the phrase's
    // arity, so the exact-set rule is phrase-aware by construction; scoping the ROWS is what stops a
    // Summary answer naming one of this book's chapter ids from passing the "is one of this Story's
    // groups" check and then failing on a confusing "not requested" refusal.
    const groups = phraseGroupsOf(store, storyId, phraseId ?? primaryPhraseOf(store, storyId)?.id);
    const byId = new Map(groups.map((group) => [group.id, group] as const));
    const requested = new Set(requestedGroupRefs);
    const seen = new Map<string, string>();

    for (const entry of rows) {
        const groupId = typeof entry.group_ref === 'string' ? entry.group_ref.trim() : '';
        const content = typeof entry.content === 'string' ? entry.content.trim() : '';

        if (groupId === '' || content === '') {
            return { ok: false, refusal: 'a `groups` entry named no group or carried empty content' };
        }

        if (!byId.has(groupId)) {
            return {
                ok: false,
                refusal: `\`${groupId}\` is not one of this Story's phrase groups — a draft answers for the group ids the job named, never for a key or an invented id`
            };
        }

        if (!requested.has(groupId)) {
            return {
                ok: false,
                refusal: `${groupId} was not one of the groups this job asked for — writing a group nobody requested would revise an untouched one (R2)`
            };
        }

        if (seen.has(groupId)) {
            return { ok: false, refusal: `${groupId} was answered twice in one answer — two texts for one group is an ambiguous batch` };
        }

        seen.set(groupId, content);
    }

    const missing = requestedGroupRefs.filter((id) => !seen.has(id));

    if (missing.length > 0) {
        const titles = missing.map((id) => byId.get(id)?.key ?? id);

        return {
            ok: false,
            refusal: `the answer left ${titles.join(', ')} unwritten — a batch that skips a group it was asked for installs nothing (R2)`
        };
    }

    return {
        ok: true,
        // Catalog order, from the STORY's rows (not from the answer's order): an install that wrote
        // groups in the answer's order would journal them differently for two identical answers, and
        // the mirror patch would then be byte-different for the same text.
        contents: groups.filter((group) => seen.has(group.id)).map((group) => ({ group, content: seen.get(group.id)! })),
        // `knowledge_used` is optional-in-spirit (an answer may lean on nothing) but required-by-schema;
        // read it defensively so a provider that downgrades to `json_object` cannot crash a settlement.
        knowledgeUsed: Array.isArray(answer?.knowledge_used) ? answer.knowledge_used.filter((id) => typeof id === 'string') : []
    };
}

// ---------------------------------------------------------------------------
// The review's answer, validated the same way
// ---------------------------------------------------------------------------

/** A `GroupReview` answer that names only real groups, or the reason it was refused. */
export type GroupReviewDecision = { ok: true; review: GroupReview } | { ok: false; refusal: string };

/**
 * Validates a `GroupReview` answer's group attribution (R3's anchor).
 *
 * The schema closes the SHAPE (an issue must carry a non-empty `group_refs` array of strings —
 * modulo `minItems`, which the in-process validator ignores); what only the book knows is whether
 * those ids EXIST. An issue naming a group the Story does not have is refused whole, for the same
 * reason a draft entry is: an attribution to a non-existent group can never be closed, so keeping
 * the issue would put a permanent, unanswerable defect in the Author's book.
 *
 * Issues keep their order and their text EXACTLY as answered (D-15: the quote is the Critic's, not
 * the loop's to tidy), and `fix_verifications` is carried through verbatim — a missing entry is a
 * graded `unknown` later (`records.ts:sampleFixDemand`'s rule), not something to invent here.
 */
export function parseGroupReviewAnswer(
    store: Store,
    storyId: string,
    structured: unknown,
    phraseId?: string
): GroupReviewDecision {
    const answer = structured as GroupReview | undefined;
    const issues = Array.isArray(answer?.issues) ? answer.issues : undefined;

    if (issues === undefined) return { ok: false, refusal: 'the GroupReview answer carried no `issues` array' };

    // A review issue is attributable only within the phrase the pass was dispatched over (seam S5).
    const owned = new Set(
        phraseGroupsOf(store, storyId, phraseId ?? primaryPhraseOf(store, storyId)?.id).map((group) => group.id)
    );
    const checked: GroupReviewIssue[] = [];

    for (const issue of issues) {
        const refs = Array.isArray(issue.group_refs) ? issue.group_refs : [];
        const known = refs.filter((ref) => typeof ref === 'string' && owned.has(ref));

        if (refs.length === 0 || known.length !== refs.length) {
            const unknown = refs.filter((ref) => !known.includes(ref));

            return {
                ok: false,
                refusal: `an issue named ${unknown.length > 0 ? unknown.join(', ') : 'no group'} outside this Story's groups — every review issue has to say which group it is about (R3)`
            };
        }

        // R3/D-15 — a `group_quotes` entry is evidence FOR a group the issue already names. A
        // quote for an unnamed group, or for an id the book does not have, is refused whole:
        // keeping it would put evidence in the review that no named scope can be closed on.
        const groupQuotes = Array.isArray(issue.group_quotes) ? issue.group_quotes : [];
        const named = new Set(refs);
        const badQuote =
            groupQuotes.find((entry) => {
                if (typeof entry?.group_ref !== 'string' || !owned.has(entry.group_ref) || !named.has(entry.group_ref)) {
                    return true;
                }

                return typeof entry?.quote !== 'string' || entry.quote.trim().length === 0;
            }) ?? undefined;

        if (badQuote !== undefined) {
            return {
                ok: false,
                refusal:
                    'a `group_quotes` entry must quote a group named in the same issue\'s `group_refs`, using an id this Story has and a non-empty quote (R3, D-15)'
            };
        }

        // R3/D-15 — EVERY named group has to be evidenced. The primary `quote` is the group the
        // prompt tells the Critic to put FIRST in `group_refs`; every other ref needs a
        // `group_quotes` entry. Without this check the old impossibility ("name three, quote one")
        // would still pass the schema and the prompt's "a group named without a quote is refused"
        // would be a promise the engine does not keep.
        const primaryGroup = refs[0];
        const quotedGroups = new Set([primaryGroup, ...groupQuotes.map((entry) => entry.group_ref)]);
        const unquoted = refs.filter((ref) => !quotedGroups.has(ref));

        if (unquoted.length > 0) {
            return {
                ok: false,
                refusal: `an issue naming ${refs.length} groups has to quote every one of them; ${unquoted.join(', ')} has no quote — put the primary quote's group first in \`group_refs\` and add a \`group_quotes\` entry for every other group (R3, D-15)`
            };
        }

        checked.push({
            ...issue,
            group_refs: [...new Set(refs)],
            ...(groupQuotes.length === 0 ? {} : { group_quotes: groupQuotes.map((entry) => ({ ...entry })) })
        });
    }

    return {
        ok: true,
        review: {
            issues: checked,
            ...(answer?.fix_verifications === undefined ? {} : { fix_verifications: answer.fix_verifications })
        }
    };
}

// ---------------------------------------------------------------------------
// The install (R2 + R5 + R6, in one commit)
// ---------------------------------------------------------------------------

/**
 * One entry's text to install: normally the `{group, content}` pair a parsed draft answer carried.
 *
 * `plotpoints` is the PHRASE ② payload — the fields the chapter's `plotlines` mirror is written from.
 * It is optional because the Summary's answer contract has no such thing (its text IS its answer), and
 * the install REQUIRES it for a chapter entry: a chapter install without plotpoints would write a
 * readable block and leave the contract the loop checks pointing at the previous pass.
 */
export interface GroupInstallEntry {
    group: PhraseGroup;
    content: string;
    plotpoints?: PlotpointFields;
}

/** Where the install came from — every one of these rides onto the new revision rows for P11's audit. */
export interface GroupInstallOptions {
    /** The run that produced the text (null for a non-run install, e.g. a future tool-side edit). */
    runRef?: string | null;
    /** The Work Item that asked for it — the ledger line that attributes an install to a job. */
    workItemRef?: string;
    /** R3: the open fix tasks this revision was written to answer. */
    taskRefs?: string[];
    /** R3: the findings those tasks named — the anchor a multi-group finding is closed on. */
    findingRefs?: string[];
    /** The Writer's declared provenance (`GroupDraft.knowledge_used`). */
    knowledgeUsed?: string[];
    /** Byte-stable prompt hash, for §5's cache audit. */
    promptHash?: string;
}

/** What an install did to the `plotlines` collection — the Plotlines Phrase's downstream sync. */
export interface GroupContractSyncResult {
    /** `plotlines` ids THIS install created (a chapter whose contract did not exist yet). */
    created: string[];
    /** `plotlines` ids THIS install updated by chapter ORDER (a redraft of an existing chapter). */
    updated: string[];
}

/** What an install did, in the exact shapes a settlement and a test can assert. */
export interface GroupInstallResult {
    /** The new `latest` rows, in the phrase's composition order. */
    installed: GroupRevision[];
    /** The rows THIS install flipped to `archived`, in the same order (one per written group that had a latest). */
    archived: GroupRevision[];
    /** The group rows after the install, the phrase's composition order. */
    groups: PhraseGroup[];
    /** The phrase row after the install: recomposed Overview, `revision` + 1. */
    phrase: Phrase;
    /**
     * What happened to the legacy `summaries` mirror (R6) — which is to say, what happened to the
     * SUMMARY phrase's downstream sync. For another phrase it is an explicit
     * `reason: 'not_summary_phrase'`, never a silent empty answer: the install knows which phrase it
     * is installing for (seam S3), and `contracts` says what it did instead.
     */
    mirror: {
        summary_id: string | null;
        fields: string[];
        written: boolean;
        reason?: 'locked' | 'no_summary' | 'not_summary_phrase';
    };
    /**
     * PHRASE ② — the chapter contracts this install wrote, from the same plotpoints as the entry texts,
     * in the same commit. Empty for a phrase with no contract mirror.
     */
    contracts: GroupContractSyncResult;
}

/**
 * Installs a batch of group texts: creates the new latest revisions, archives the ones they replace,
 * recomposes the Overview, and rewrites the legacy Summary mirror — all in the CALLER's commit.
 *
 * THE TWO RULES THAT ARE EASY TO GET WRONG, stated where they are enforced:
 *
 *   - `chapter_count` is NEVER written here. It is Author truth (D-3b): a Writer that could change
 *     the chapter count through a prose install would be choosing a hard fact. `world_rules` is
 *     likewise untouched (R1: it is the deprecated field with no group).
 *   - a LOCKED Summary is not rewritten (L-7a/P5): the lock is the Author's declaration that the
 *     Summary is law, and an install that wrote through it would put the loop above a sign-off. The
 *     group revision rows still land (the group history is the redesign's truth and a locked mirror
 *     does not make a written group text a lie), and the result REPORTS the skipped mirror so the
 *     caller can journal the fact instead of discovering it in a projection. Generation is expected
 *     to stop offering group work while the lock is on, so this is the guard, not the routine path.
 *
 * `contents` arrives in catalog order (see {@link parseGroupDraftAnswer}); an entry whose group no
 * longer exists in the book throws the store's own "no phrase_group named X" rather than being
 * skipped, because at that point the caller's batch and the book disagree and silently continuing
 * would install a batch the Author never saw.
 *
 * A LOCKED GROUP IS REFUSED, WHOLE BATCH AND BEFORE THE FIRST WRITE (R-LOCK): see the check below for
 * the rule and `phrase/locks.ts` for how a group gets into that state. Note the two locks are NOT the
 * same flag — `summaries.locked` (L-7a) freezes the legacy MIRROR and lets the group rows install,
 * while `phrase_groups.locked` freezes the GROUP row itself, so the mirror rule below and the group rule
 * above point in opposite directions on purpose.
 */
export function installGroupRevisions(
    store: Store,
    story: Story,
    entries: readonly GroupInstallEntry[],
    attribution: Attribution,
    options: GroupInstallOptions = {}
): GroupInstallResult {
    // -- Refuse the whole batch before the first write (the file header's atomicity rule) ---------
    if (entries.length === 0) {
        throw new Error('installGroupRevisions: an empty batch installs nothing — the caller should not have dispatched it');
    }

    for (const entry of entries) {
        if (entry.content.trim() === '') {
            throw new Error(`installGroupRevisions: ${entry.group.key} arrived with empty content — an empty group text is a refusal, not a revision`);
        }

        // THE GROUP LOCK (R-LOCK), checked against the ROW rather than the caller's copy: a Writer batch
        // is planned off `groupWorkTargets`, which never offers a locked group, so the only way an entry
        // names one is a lock that landed while the pass was already running (or a hand call that skipped
        // the planner). Either way the text in hand is stale by definition — the Writer never saw the
        // signed-off version — and installing it would put a paragraph the Author declared final back into
        // circulation. This is the same before-the-first-write check the empty-content rule lives in, so a
        // batch with one locked target installs NOTHING rather than half its groups (R2's atomicity).
        const current = store.phraseGroups.get(entry.group.id);

        if (isPhraseGroupLocked(current) || isPhraseGroupLocked(entry.group)) {
            const row = current ?? entry.group;

            throw new Error(
                `installGroupRevisions: ${row.key} is locked at revision ${row.locked_revision ?? row.revision}${
                    row.locked_by === undefined || row.locked_by === null ? '' : ` by ${row.locked_by}`
                } — a locked group's text is the fixed point the other groups are revised against, so nothing installs over it until the Author unlocks it`
            );
        }
    }

    // THE PHRASE IS THE ENTRIES', not "the Story's Summary" (seam S5): a batch of chapter entries
    // belongs to the Plotlines phrase, and recomposing the Summary row over them would write an
    // Overview out of chapters. The entry's own `phrase_id` is the address the catalog minted and the
    // rows already carry, so it needs no guessing; the fallback to the Story's PRIMARY phrase is only
    // for a caller that handed a group built outside the catalog, and it is the row every pre-Phrase-②
    // call site has always meant.
    const phrase = store.phrases.get(entries[0].group.phrase_id) ?? primaryPhraseOf(store, story.id);

    if (phrase === undefined) {
        throw new Error(
            `installGroupRevisions: story ${story.id} has no Phrase row — ensurePhraseCatalog must create the catalog before any group is written`
        );
    }

    // THE DOWNSTREAM SYNC IS CHOSEN BEFORE THE FIRST WRITE (seam S3), and the three arms are the whole
    // list of what an install mirrors:
    //   - the SUMMARY phrase mirrors §4.2's legacy prose fields (R6), and nothing else;
    //   - the PLOTLINES phrase mirrors §4.3's `plotlines` contract, and REQUIRES the plotpoints to do
    //     it — an entry without them would leave the contract the loop checks pointing at the last
    //     pass while the entry text moved on;
    //   - any other phrase key THROWS. A new phrase kind must say here what its install writes below
    //     the entry rows; the alternative — falling through to "mirrored nothing" — is the silent no-op
    //     this seam exists to forbid, because a batch that syncs nothing still spends a claim key and an
    //     attempt and looks, from the journal, exactly like a batch that synced everything.
    if (phrase.key === PHRASE_PLOTLINES_KEY) {
        for (const entry of entries) {
            if (entry.plotpoints === undefined) {
                throw new Error(
                    `installGroupRevisions: ${entry.group.key} arrived without plotpoints — a chapter entry install has to carry the contract it writes, or the \`plotlines\` row it mirrors keeps the previous pass's plotpoints (P4)`
                );
            }
        }
    } else if (phrase.key !== PHRASE_SUMMARY_KEY) {
        throw new Error(
            `installGroupRevisions: the "${phrase.key}" phrase has no declared downstream sync — a new phrase kind must say what its install writes below the entry rows instead of installing a batch that silently mirrors nothing (seam S3)`
        );
    }

    // -- The writes -------------------------------------------------------------------------------
    const installed: GroupRevision[] = [];
    const archived: GroupRevision[] = [];
    const groups: PhraseGroup[] = [];
    const contracts: GroupContractSyncResult = { created: [], updated: [] };

    for (const entry of entries) {
        const current = latestGroupRevision(store, entry.group.id);

        // Archive the row this text replaces BEFORE creating the new one, so a mid-install failure
        // can never leave TWO rows claiming `latest` for one group (the invariant every read above
        // depends on). A group's very first install has nothing to archive.
        if (current !== undefined) {
            archived.push(
                store.groupRevisions.update(
                    current.id,
                    { state: 'archived' },
                    {
                        ...attribution,
                        why: `${attribution.why}; archived ${entry.group.key} revision ${current.number} as the superseded text (R2)`
                    },
                    [{ id: current.id, rev: current.rev }]
                )
            );
        }

        const created = store.groupRevisions.create(
            {
                story_id: story.id,
                phrase_id: entry.group.phrase_id,
                group_id: entry.group.id,
                // The key is denormalised onto the row (R2) so an Author's history stays readable
                // after a catalog retitling, and a finding's closure can be re-derived without a join.
                group_key: entry.group.key,
                // Numbered from the GROUP's own line, not from a global counter (R2: each group has
                // its own sequential revision line, and one group's work must not renumber another's).
                number: entry.group.revision + 1,
                content: entry.content.trim(),
                state: 'latest',
                run_ref: options.runRef ?? null,
                ...(options.workItemRef === undefined ? {} : { work_item_ref: options.workItemRef }),
                ...(options.taskRefs === undefined || options.taskRefs.length === 0
                    ? {}
                    : { task_refs: [...options.taskRefs] }),
                ...(options.findingRefs === undefined || options.findingRefs.length === 0
                    ? {}
                    : { finding_refs: [...options.findingRefs] }),
                knowledge_used: options.knowledgeUsed ?? [],
                ...(options.promptHash === undefined ? {} : { prompt_hash: options.promptHash })
            },
            attribution
        );

        installed.push(created);

        // The group row carries the CURRENT text and number, rewritten in the same commit as the row
        // that made them, so `revision` and the `latest` row cannot drift apart.
        groups.push(
            store.phraseGroups.update(
                entry.group.id,
                { content: created.content, revision: created.number, updated_by: options.runRef ?? null },
                attribution,
                [{ id: entry.group.id, rev: entry.group.rev }]
            )
        );

        // PLOTLINES MIRROR (§4.3 — the Phrase ② equivalent of R6's legacy mirror): the chapter's
        // contract is rewritten from the SAME plotpoints the entry text was composed from. HERE rather
        // than after the loop, so a batch that throws on its fourth chapter cannot leave three chapters
        // with a new contract and one chapter with a new text; the store's rollback makes the commit
        // atomic either way, and this ordering keeps the invariant true in the middle of the loop too.
        if (phrase.key === PHRASE_PLOTLINES_KEY && entry.plotpoints !== undefined) {
            const synced = syncPlotlineContract(store, story, entry.group, entry.plotpoints, attribution);

            if (synced.created) contracts.created.push(synced.row.id);
            else contracts.updated.push(synced.row.id);
        }
    }

    // -- The phrase's whole text, recomposed from the rows as they now are --------------------------
    const refreshed = phraseGroupsOf(store, story.id, phrase.id);
    const updatedPhrase = store.phrases.update(
        phrase.id,
        // Recomposed from the REFRESHED rows (not from `entries`): an entry this batch did not touch
        // still belongs in the phrase's text, and composing from the batch alone would drop the entries
        // the Author already has. `catalog`'s composition rule owns the format (one home for it), and
        // the RANK IS RESOLVED INSIDE THIS PHRASE (seam S7): the Summary's five catalog keys, a chapter
        // set's chapter numbers. For the Summary the two ranks are the same function, so the Overview
        // this writes is byte-identical to the one this install always produced.
        {
            content: composeGroupContentFrom(refreshed, (key) => phraseGroupRankOf(phrase.key, key)),
            revision: phrase.revision + 1
        },
        attribution,
        [{ id: phrase.id, rev: phrase.rev }]
    );

    // -- The downstream sync, in the same commit, chosen per phrase (seam S3) -----------------------
    // The arm taken is the one the check BEFORE the first write proved exists. `syncSummaryMirror` is
    // explicitly the SUMMARY phrase's sync: the `summaries` row is the legacy record Phrase ①'s five
    // groups were built to mirror (R6), and Phrase ② has no legacy record to mirror into — its mirror is
    // the `plotlines` contract written in the loop above. Saying so here, with a reason in the result,
    // is what keeps "this phrase has no prose mirror" a readable fact instead of a fallthrough nobody
    // can see.
    let mirror: GroupInstallResult['mirror'];

    if (phrase.key === PHRASE_SUMMARY_KEY) {
        mirror = syncSummaryMirror(store, story, groups, attribution);
    } else if (phrase.key === PHRASE_PLOTLINES_KEY) {
        mirror = { summary_id: null, fields: [], written: false, reason: 'not_summary_phrase' };
    } else {
        // Unreachable — the pre-write check refused this batch. It stays as an assertion so a later
        // phrase kind added to one of the two lists and not the other fails loudly rather than reporting
        // a mirror it never wrote.
        throw new Error(`installGroupRevisions: no downstream sync is declared for the "${phrase.key}" phrase (seam S3)`);
    }

    return { installed, archived, groups, phrase: updatedPhrase, mirror, contracts };
}

/**
 * Rewrites the legacy `summaries` prose fields from the installed group texts (R6).
 *
 * THIS IS THE SUMMARY PHRASE'S SYNC AND IT IS CALLED FROM EXACTLY ONE ARM of the install's phrase
 * branch. It is not "the install's mirror" in general: the map it reads is typed to the Summary's five
 * keys precisely so a chapter key can never be pushed through it, and a phrase without a legacy record
 * reports `reason: 'not_summary_phrase'` from the install rather than arriving here and quietly writing
 * nothing (seam S3).
 *
 * THE MIRROR IS A PROJECTION, NOT A SECOND SOURCE: it is written from the group rows in the same
 * commit that made them current, it maps by {@link SUMMARY_MIRROR_FIELDS} (the identity map — the
 * five groups ARE §4.2's five prose fields), and it never writes `chapter_count` (Author truth,
 * D-3b) or `world_rules` (deprecated, no group, R1). A reader that wants the truth reads the groups;
 * a reader that has not been updated reads this and still gets the current text.
 *
 * Exported because the Author-facing tool path (a direct `editSummary`-style write on one group,
 * later) needs the same sync rule rather than a copy of it.
 */
export function syncSummaryMirror(
    store: Store,
    story: Story,
    groups: readonly PhraseGroup[],
    attribution: Attribution
): GroupInstallResult['mirror'] {
    const summary = store.summaries.list().find((row) => row.story_id === story.id);

    if (summary === undefined) {
        // No Summary row to mirror onto. Creating one here would mean inventing `chapter_count`
        // (Author truth), so the honest answer is "nothing was mirrored" plus the reason.
        return { summary_id: null, fields: [], written: false, reason: 'no_summary' };
    }

    if (summary.locked) {
        // L-7a/P5: the lock is the Author's declaration. The group rows keep their install; the
        // mirror waits for the Author to lift the lock (and the projection reports the difference).
        return { summary_id: summary.id, fields: [], written: false, reason: 'locked' };
    }

    const patch: Partial<Summary> = {};
    const fields: string[] = [];

    for (const group of groups) {
        const field = SUMMARY_MIRROR_FIELDS[group.key as keyof typeof SUMMARY_MIRROR_FIELDS] as
            | SummaryMirrorField
            | undefined;

        // A group the catalog does not mirror (a retired key still on the book) is skipped rather
        // than guessed at: guessing would put text in a field the Author never defined.
        if (field === undefined) continue;

        (patch as Record<string, string>)[field] = group.content;
        fields.push(field);
    }

    if (fields.length === 0) return { summary_id: summary.id, fields: [], written: false };

    store.summaries.update(summary.id, patch, attribution, [{ id: summary.id, rev: summary.rev }]);

    return { summary_id: summary.id, fields, written: true };
}
