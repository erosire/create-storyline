/**
 * Store-backed helpers for the §8 tool groups, on W1's synchronous store.
 *
 * Everything here is story-scoped (T-3): `list()` and `get()` are global because the dashboard
 * addresses records by id, so the tool boundary is where a run is kept inside its own Story.
 * Refs are resolved against the Story's own records, and a ref that names the wrong kind of
 * record produces a refusal that says what it IS (T-11), which is what makes P10 enforceable.
 */
import { COLLECTION_SINGULARS, type CollectionName } from '../../shared/types';
import { criterionById, defaultGoal } from '../../shared/criteria';
import type {
    CastMember,
    Chapter,
    ChapterSection,
    Digest,
    Finding,
    Goal,
    Idea,
    LedgerEntry,
    Plotline,
    Proposal,
    Revision,
    Story,
    StoredRecord,
    Summary,
    Task,
    Verdict
} from '../../shared/types';
import type { CAS, Store } from '../store/store';
import {
    buildAttribution,
    clip,
    commitAs,
    computeFingerprint,
    findingFingerprint,
    scopedGet,
    scopedRows,
    ToolRefusal,
    ideaFingerprint
} from './utilities';
import type { ToolExecutionContext } from './types';

/** The §4 collection a `unit_ref`/`target_ref` may name, in the order the resolver tries them. */
export type RefKind = CollectionName;

/** A resolved ref: the record's id, its collection, and the human label a refusal quotes. */
export interface ResolvedRef {
    collection: CollectionName;
    id: string;
    /** §4's `heading`/`title`/`name` when the record has one, else the id. */
    label: string;
    /** The record itself, so a tool does not re-read it. */
    record: unknown;
}

/** Collections a ref may name; the store's own singular map makes the labels exact. */
const RESOLVABLE: RefKind[] = [
    // The Story row is a real ref target, not a mistake: §5.2 scopes C-4 and every `whole`-level
    // criterion to it (criteria/engine.ts:scopeTargets), the loop files the set-level unit's
    // judgements there (loop/work.ts:judgedBefore), and checker.ts:TARGET_KINDS' own comment reads
    // "plus the Story itself". Listing it first is what lets a whole-Story verdict resolve instead
    // of coming back as a `wrongKind` sniff.
    'stories',
    'summaries',
    'plotlines',
    'chapters',
    'cast',
    'ledger',
    'ideas',
    'revisions',
    'verdicts',
    'findings',
    'goals',
    'tasks',
    'proposals',
    'directives',
    'digests',
    'templates',
    // The Phase-1 collections (documents/phase-1-research-pipeline.md §3.2-§3.4). They are listed
    // so a §7.1 tool can name one by id: `retireKnowledge` takes a `knowledge_id`, and the loop's
    // engine-side settlement (step 9 of the plan) reads a `seed_brief`/`sample_review` ref. Story
    // scoping needs no special case — every one of the three carries `story_id`, so the same
    // `inStoryScope`/`rowsInStoryScope` path `findings`/`revisions` use applies unchanged.
    'knowledge',
    'seed_briefs',
    'sample_reviews',
    // The Summary Phrase collections (R3). `phrase_groups` is the one a §7.1 tool NAMES by id today:
    // `raiseFinding`'s `group_refs` argument carries `phrase_groups.id` values, and an invented id
    // has to be refused with the label this list produces ("that id is a phrase group") rather than
    // stored as an attribution nothing can ever close. `phrases` and `group_revisions` join the list
    // for the same reason a later tool (a group editor, a history read) will name them, and because
    // a partially-resolvable registry is the kind of half-rule that costs a debugging session.
    'phrases',
    'phrase_groups',
    'group_revisions'
];

/** A label for one collection, singular, for refusal prose ("that id is a chapter"). */
export function kindLabel(collection: CollectionName): string {
    return COLLECTION_SINGULARS[collection].replace(/_/g, ' ');
}

/**
 * The generic shape the ref resolver needs from one collection (W1's `Collection`).
 *
 * WHY AN EXPLICIT MAP RATHER THAN `store[collection]`: the registry key and the `Store` field name
 * diverge for the three Phase-1 collections (`seed_briefs` → `store.seedBriefs`,
 * `sample_reviews` → `store.sampleReviews`), so a generic index over `CollectionName` is not a
 * type the compiler can prove. A `Record<CollectionName, …>` is total by construction: adding a
 * §4 collection without adding it here is a type error, which is exactly the guard we want.
 */
const COLLECTION_ACCESSOR: Record<
    CollectionName,
    (store: Store) => { list(): unknown[]; get(id: string): unknown }
> = {
    stories: (store) => store.stories,
    summaries: (store) => store.summaries,
    plotlines: (store) => store.plotlines,
    chapters: (store) => store.chapters,
    cast: (store) => store.cast,
    ledger: (store) => store.ledger,
    tasks: (store) => store.tasks,
    digests: (store) => store.digests,
    verdicts: (store) => store.verdicts,
    findings: (store) => store.findings,
    goals: (store) => store.goals,
    templates: (store) => store.templates,
    runs: (store) => store.runs,
    directives: (store) => store.directives,
    revisions: (store) => store.revisions,
    ideas: (store) => store.ideas,
    proposals: (store) => store.proposals,
    knowledge: (store) => store.knowledge,
    // `seed_briefs`/`sample_reviews` are the two registry keys whose Store field is camelCase
    // (store.ts:482-484), which is the whole reason the map exists.
    seed_briefs: (store) => store.seedBriefs,
    sample_reviews: (store) => store.sampleReviews,
    // The Summary Phrase collections (R3): a finding's `group_refs` are resolved through here, so an
    // id naming no group of this Story is a refusal with a label instead of a dangling attribution.
    phrases: (store) => store.phrases,
    phrase_groups: (store) => store.phraseGroups,
    group_revisions: (store) => store.groupRevisions
};

/** Reads the store's typed collection by name without a per-collection switch. */
export function collectionOf(
    store: Store,
    collection: CollectionName
): { list(): unknown[]; get(id: string): unknown } {
    const access = COLLECTION_ACCESSOR[collection];
    // A name outside the registry cannot reach this map (the parameter is `CollectionName`), so
    // this branch is unreachable for typed callers; it keeps a runtime caller from crashing.
    if (!access) return { list: () => [], get: () => undefined };
    return access(store);
}

/** A record's `story_id`, for the T-3 scope check. */
function storyIdOf(record: unknown): string {
    if (typeof record !== 'object' || record === null) return '';
    const value = (record as { story_id?: unknown }).story_id;
    return typeof value === 'string' ? value : '';
}

/**
 * T-3's scope test, collection-aware. §4.1 gives the Story row no `story_id` — the row IS the
 * Story — so its scope is its own id, and a plain field read would drop every Story ref.
 */
function inStoryScope(collection: RefKind, record: unknown, storyId: string): boolean {
    if (collection === 'stories') return (record as { id?: string }).id === storyId;

    return storyIdOf(record) === storyId;
}

/** The Story's rows for one collection (T-3: every read is scoped, P3), with the §4.1 exception. */
function rowsInStoryScope(store: Store, collection: RefKind, storyId: string): unknown[] {
    const rows = collectionOf(store, collection).list() as unknown[];

    if (collection === 'stories') return rows.filter((row) => (row as { id?: string }).id === storyId);

    return scopedRows(rows, storyId);
}

/** A record's human label: the fields §4 gives each collection, in the order they appear. */
function labelOf(collection: CollectionName, record: Record<string, unknown>): string {
    const heading = typeof record.heading === 'string' ? record.heading : '';
    const title = typeof record.title === 'string' ? record.title : '';
    const name = typeof record.name === 'string' ? record.name : '';
    const subject = typeof record.subject === 'string' ? record.subject : '';
    // `knowledge` (§3.2) has no §4 label field: its searchable key is the normalised `topic`, so a
    // `knowledge_id` may name the topic ("1880 revolvers") instead of `knowledge_entry_4`.
    const topic = typeof record.topic === 'string' ? record.topic : '';
    const order = typeof record.order === 'number' ? `#${record.order}` : '';
    const id = typeof record.id === 'string' ? record.id : '';
    return heading || title || name || subject || topic || order || id || kindLabel(collection);
}

/**
 * Resolves one ref against the current Story's records (T-3), trying, in order: an exact id,
 * a `kind:id` pair, a unique id prefix, an `order` number for the numbered collections, and a
 * unique label match. `expect` narrows the collections the caller can accept; a ref that
 * resolves to a real record OUTSIDE `expect` comes back as `wrongKind` so the caller can name
 * the mistake precisely (T-11/P10).
 */
export async function resolveRef(
    store: Store,
    storyId: string,
    ref: string,
    expect: RefKind[]
): Promise<{ resolved: ResolvedRef | null; wrongKind: RefKind | null }> {
    const trimmed = String(ref ?? '').trim();
    if (!trimmed) return { resolved: null, wrongKind: null };

    // `kind:id` / `kind:label` — the kind hint is honoured first.
    const colon = trimmed.indexOf(':');
    const declared = colon > 0 ? trimmed.slice(0, colon) : '';
    const rest = colon > 0 ? trimmed.slice(colon + 1) : trimmed;
    const declaredCollection = declared
        ? (RESOLVABLE.find((name) => name === declared || COLLECTION_SINGULARS[name] === declared) ?? null)
        : null;
    if (declared && !declaredCollection) {
        // The caller asked for a collection that does not exist at all.
        return { resolved: null, wrongKind: null };
    }
    const candidates: RefKind[] = declaredCollection ? [declaredCollection] : expect;

    // 1. exact id, inside the Story only.
    for (const collection of candidates) {
        const record = collectionOf(store, collection).get(rest);
        if (record && inStoryScope(collection, record, storyId))
            return { resolved: toRef(collection, record), wrongKind: null };
    }
    // 2. `order` for the numbered collections (a Writer says "chapter 3").
    if (/^\d+$/.test(rest)) {
        const order = Number(rest);
        for (const collection of candidates) {
            if (collection !== 'chapters' && collection !== 'plotlines') continue;
            const rows = (rowsInStoryScope(store, collection, storyId) as Array<{ order: number }>).filter(
                (row) => row.order === order
            );
            if (rows.length === 1) return { resolved: toRef(collection, rows[0]), wrongKind: null };
        }
    }
    // 3. unique id prefix (ids are minted, so a clipped digest can truncate one).
    for (const collection of candidates) {
        const rows = rowsInStoryScope(store, collection, storyId) as Array<{ id: string }>;
        const hits = rows.filter((row) => row.id.startsWith(rest));
        if (hits.length === 1) return { resolved: toRef(collection, hits[0]), wrongKind: null };
    }
    // 4. unique label match.
    for (const collection of candidates) {
        const rows = rowsInStoryScope(store, collection, storyId) as Record<string, unknown>[];
        const needle = rest.toLowerCase();
        const hits = rows.filter(
            (row) =>
                labelOf(collection, row).toLowerCase() === needle ||
                labelOf(collection, row).toLowerCase().includes(needle)
        );
        if (hits.length === 1) return { resolved: toRef(collection, hits[0]), wrongKind: null };
    }
    if (declaredCollection) return { resolved: null, wrongKind: null };

    // 5. the ref names a record in a collection the caller did not ask for: report the kind.
    const prefix = trimmed.replace(/_\d+$/, '');
    const sniffed = RESOLVABLE.find((name) => COLLECTION_SINGULARS[name] === prefix);
    // `collectionOf`, not `store[sniffed]`: the three Phase-1 collections key differently on the
    // Store (see COLLECTION_ACCESSOR), so the sniff must go through the same map every read does.
    const sniffedRecord = sniffed === undefined ? undefined : collectionOf(store, sniffed).get(trimmed);
    if (sniffed && !expect.includes(sniffed) && sniffedRecord && inStoryScope(sniffed, sniffedRecord, storyId)) {
        return { resolved: null, wrongKind: sniffed };
    }
    for (const collection of RESOLVABLE) {
        if (expect.includes(collection)) continue;
        const rows = scopedRows(collectionOf(store, collection).list() as Array<{ id: string }>, storyId);
        if (rows.some((row) => row.id === trimmed)) return { resolved: null, wrongKind: collection };
    }
    return { resolved: null, wrongKind: null };
}

/** Builds the resolved shape from any record. */
function toRef(collection: CollectionName, record: unknown): ResolvedRef {
    const data = record as Record<string, unknown>;
    return {
        collection,
        id: String(data.id ?? ''),
        label: labelOf(collection, data),
        record
    };
}

/** The refusal every ref-taking tool shares: names the rule, the ref, and the read to redo. */
export function refNotFound(ref: string, expect: RefKind[], wrongKind: RefKind | null): ToolRefusal {
    const names = expect.map(kindLabel).join(' or ');
    // The FIX names the read in plural ("re-read chapters"), because the thing to redo is the
    // read that lists the collection; the prose stays singular ("no chapter matching X"), which is
    // what actually reads correctly inside a sentence.
    const collections = expect.join(' or ');
    if (wrongKind) {
        return new ToolRefusal(
            'T-11',
            `"${ref}" is a ${kindLabel(wrongKind)}, not a ${names}, so the rule cannot apply to it`,
            {
                ref,
                kind: wrongKind,
                expected_kinds: expect,
                fix: `read ${collections} first and pass one of those`
            }
        );
    }
    return new ToolRefusal(
        'T-3',
        `no ${names} matching "${ref}" exists in this Story, and a run only sees its own Story's records`,
        {
            ref,
            expected_kinds: expect,
            fix: `re-read ${collections} and pass a record from this Story`
        }
    );
}

/** Resolves a ref or throws the shared refusal — the shape almost every tool wants. */
export async function mustResolveRef(
    ctx: Pick<ToolExecutionContext, 'store' | 'storyId'>,
    ref: unknown,
    argName: string,
    expect: RefKind[]
): Promise<ResolvedRef> {
    const text = String(ref ?? '').trim();
    if (!text) {
        throw new ToolRefusal('T-11', `${argName} is required, and it names the record to work on`, {
            field: argName,
            expected_kinds: expect,
            fix: `pass a ${expect.map(kindLabel).join(' or ')}`
        });
    }
    const { resolved, wrongKind } = await resolveRef(ctx.store, ctx.storyId, text, expect);
    if (resolved) return resolved;
    throw refNotFound(text, expect, wrongKind);
}

// ── typed views over a resolved ref ─────────────────────────────────────────

/**
 * A resolved ref read as the record the tool asked for. The resolver already narrowed the
 * collection, so this is a narrowing cast rather than a re-read — and it keeps the T-3 scope
 * guarantee, because the resolver only ever matches records in this Story.
 */
export const resolvedChapter = (ref: ResolvedRef): Chapter => ref.record as Chapter;
export const resolvedPlotline = (ref: ResolvedRef): Plotline => ref.record as Plotline;
export const resolvedSummary = (ref: ResolvedRef): Summary => ref.record as Summary;
export const resolvedRevision = (ref: ResolvedRef): Revision => ref.record as Revision;
export const resolvedIdea = (ref: ResolvedRef): Idea => ref.record as Idea;
export const resolvedCast = (ref: ResolvedRef): CastMember => ref.record as CastMember;
export const resolvedLedger = (ref: ResolvedRef): LedgerEntry => ref.record as LedgerEntry;
export const resolvedTask = (ref: ResolvedRef): Task => ref.record as Task;

/**
 * D-3d/D-21/D-38a/D-17d: whether this Story's assignment can put more than one draft of the same
 * unit side by side. True when an assigned template names several writer roles, gives a writer
 * role `agents > 1` (D-38's panel), or sets `attempts > 1` (D-17d: parallel revisions per unit).
 *
 * This is a LOCAL MIRROR of the dispatch decision: the run layer (W4/W8) owns what actually
 * fans out, and the tool layer only needs the question "must a prose write file a competing
 * revision instead of replacing the text?" (D-3d). It reads the template rows the Story is
 * assigned (`stories.template_refs`, D-17b) rather than the run's own template, because a
 * sub-context inherits its parent's template (T-2b) and must not see a thinner answer.
 */
export function isDivergenceMode(store: Store, story: Story): boolean {
    const templates = store.templates
        .list()
        .filter((template) => story.template_refs.includes(template.name) || story.template_refs.includes(template.id));
    let writers = 0;
    for (const template of templates) {
        const writerRoles = template.roles.filter((role) => role.kind === 'writer');
        writers += writerRoles.length;
        if (writerRoles.some((role) => (role.agents ?? 1) > 1)) return true;
        if (writerRoles.length && template.attempts > 1) return true;
    }
    return writers > 1;
}

// ── typed reads (all Story-scoped, T-3) ─────────────────────────────────────

/**
 * The minted suffix of a story-local id (`revision_10` → 10), or `undefined` for an id the store
 * did not mint (`store/store.ts:Collection.create` writes `${singular}_${n}`, zero-based).
 *
 * WHY THIS IS THE CREATION-ORDER SIGNAL: §4 rows carry no ordering column and `rev` is the CAS
 * token, not a sequence. The suffix IS a per-collection monotonic counter, so it is the only field
 * that says which of two rows a run wrote first. A suffix like `1a` or `0_1` is not the store's, so
 * it declines to answer rather than guessing.
 */
const mintedSuffix = (id: string): number | undefined => {
    const cut = id.lastIndexOf('_');

    if (cut < 0) return undefined;

    const suffix = id.slice(cut + 1);

    // `Number('')` is 0, which would silently rank a hand-written `revision_` as the oldest mint.
    return /^\d+$/.test(suffix) ? Number(suffix) : undefined;
};

/**
 * The ordering the newest-first row readers below promise: `created_at` DESC, and for rows minted in
 * the same millisecond — which phase ①'s sampling and screening produce constantly, because the
 * engine writes a whole fan-out inside one sweep — the minted id DESC.
 *
 * WHY NOT A BARE `b.id.localeCompare(a.id)` FOR THE TIE:
 *   * local ids are ZERO-BASED counters that pass 9 on the first sampling round, and lexically
 *     `revision_2` sorts above `revision_10` — so a lexical tie-break puts the THIRD-OLDEST draft of a
 *     round of eleven first and reports it as the newest one. The minted suffix is compared as a
 *     NUMBER to keep creation order intact (see `mintedSuffix`).
 *   * where the suffix cannot answer (a hand-minted id such as `revision_1a`), the fallback is the
 *     id's UTF-16 CODE UNITS rather than `localeCompare`, whose collation is locale- and
 *     ICU-version-dependent: the row order a Reader sees must not depend on the host's locale.
 *
 * Rows are read per collection, so a tie is always between two ids of one prefix and the two rules
 * above cannot disagree about which one came later. Exported for the focused same-millisecond test
 * (`artifacts.test.ts`), which is the only way to pin a tie without racing the clock.
 */
export function compareNewestFirst(a: StoredRecord, b: StoredRecord): number {
    const byCreated = b.created_at.localeCompare(a.created_at);

    if (byCreated !== 0) return byCreated;

    const left = mintedSuffix(a.id);
    const right = mintedSuffix(b.id);

    if (left !== undefined && right !== undefined && left !== right) return right - left;

    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export const storyRows = (store: Store, storyId: string): Story | undefined =>
    scopedGet(store.stories.get(storyId), storyId);
export const summaryRow = (store: Store, storyId: string): Summary | undefined =>
    scopedRows(store.summaries.list(), storyId)[0];
export const plotlineRows = (store: Store, storyId: string): Plotline[] =>
    [...scopedRows(store.plotlines.list(), storyId)].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
export const chapterRows = (store: Store, storyId: string): Chapter[] =>
    [...scopedRows(store.chapters.list(), storyId)].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
export const castRows = (store: Store, storyId: string): CastMember[] => scopedRows(store.cast.list(), storyId);
export const ledgerRows = (store: Store, storyId: string): LedgerEntry[] => scopedRows(store.ledger.list(), storyId);
// D-3d/D-21/D-38a/D-17d: ideas, revisions, verdicts and findings all read newest-first, so the
// comparator is shared rather than re-spelled four times (each of the four once had a tie-break that
// compared a row's id with itself, which answered 0 and left same-ms rows in CREATION order).
export const ideaRows = (store: Store, storyId: string): Idea[] =>
    [...scopedRows(store.ideas.list(), storyId)].sort(compareNewestFirst);
export const revisionRows = (store: Store, storyId: string): Revision[] =>
    [...scopedRows(store.revisions.list(), storyId)].sort(compareNewestFirst);
export const verdictRows = (store: Store, storyId: string): Verdict[] =>
    [...scopedRows(store.verdicts.list(), storyId)].sort(compareNewestFirst);
export const findingRows = (store: Store, storyId: string): Finding[] =>
    [...scopedRows(store.findings.list(), storyId)].sort(compareNewestFirst);
export const taskRows = (store: Store, storyId: string): Task[] =>
    [...scopedRows(store.tasks.list(), storyId)].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
export const proposalRows = (store: Store, storyId: string): Proposal[] => scopedRows(store.proposals.list(), storyId);

/** The one open finding set a deletion or a lock has to respect (D-33/D-16's live states). */
export const OPEN_FINDING_STATES: Finding['state'][] = ['unconfirmed', 'confirmed', 'approved'];

/** True when a chapter still has a live finding, which blocks deleting it (D-22/D-33). */
export function hasOpenFindings(store: Store, storyId: string, targetRef: string): boolean {
    return findingRows(store, storyId).some(
        (row) => row.target_ref === targetRef && OPEN_FINDING_STATES.includes(row.state)
    );
}

/** The Digest a fresh run stands on: the `current` row, or the newest one (D-12a). */
export function currentDigest(store: Store, storyId: string): Digest | undefined {
    const rows = scopedRows(store.digests.list(), storyId);
    return rows.find((row) => row.current === true) ?? rows[rows.length - 1];
}

/**
 * The Goal the phase is measured against (G-4). A Story without a `goals` row is read with the
 * built-in default rather than written with it: a read tool must not create records (D-12a).
 */
export function goalFor(store: Store, storyId: string, phase: Story['phase']): Goal {
    const rows = scopedRows(store.goals.list(), storyId);
    return rows.find((row) => row.story_id === storyId || row.story_id === undefined) ?? defaultGoal(storyId);
}

/** The `n/m` a verdict renders (P6: rendered, never scored into a number that ranks prose). */
export function scoreLine(passed: number, total: number): string {
    return `${passed}/${total}`;
}

/** A criterion's definition, for hard/soft counting (D-15). Unknown ids count as HARD. */
export function criterionHard(id: string): boolean {
    const criterion = criterionById(id.trim());
    // §5: a criterion the built-in list does not know is a custom one, and a custom criterion
    // is hard until the Goal says otherwise — the safe reading is that it can block a pass.
    return criterion ? criterion.hard : true;
}

// ── §4.15 revisions (D-3d/D-21/D-22) ────────────────────────────────────────

/** The draft body shape a Writer files, per unit kind (§4.15 `body: unknown`). */
/**
 * The one place §4.15's open `body: unknown` is agreed with a unit kind (T-2a/D-22).
 *
 * A chapter draft stores `{sections: ChapterSection[]}` and a Summary/plotline draft stores
 * `{fields: {...}}` — that is what `fileRevision` writes (`editChapter` in a diverging Story
 * files `{sections}`), and it is what `revisionBodySections`/`revisionBodyFields` must read back.
 * A BARE array or bare object is accepted too and wrapped, because §4.15 leaves the column open and
 * an older draft may have left the shorter shape behind.
 *
 * WHY THIS IS NOT just `{ sections: value }`: wrapping unconditionally makes every stored draft
 * unreadable — `{sections: [...]}` would become `{sections: {sections: [...]}}`, which is not an
 * array, so `selectRevision` would install an EMPTY chapter and silently delete the competing text
 * it did not choose (D-22's whole promise). Both shapes are therefore normalised here, once, so the
 * install and the side-by-side read cannot disagree.
 */
export function revisionBody(unitKind: Revision['unit_kind'], value: unknown): Record<string, unknown> {
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
    if (unitKind === 'chapter') {
        // Bare array first: it is the shorter shape, and an object with a `sections` array is the
        // stored one. Anything else (a string, null, a fields-shaped draft) has no prose to install.
        if (Array.isArray(value)) return { sections: value };
        if (record && Array.isArray(record.sections)) return { sections: record.sections };
        return { sections: [] };
    }
    if (record) {
        // A stored `{fields}` draft wins over a bare fields object, so a draft that carries both
        // keys cannot have its contract read from the wrong half.
        if (record.fields && typeof record.fields === 'object') return { fields: record.fields };
        if (!('sections' in record)) return { fields: record };
    }
    return { fields: {} };
}

/**
 * Same mapping, named for who calls it: a Writer filing a draft says which unit kind the body
 * belongs to, and §4.15 leaves the shape open, so this is the one place the two shapes are
 * agreed (`{sections}` for a chapter, `{fields}` for a summary or a plotline contract).
 */
export const revisionBodyForUnit = revisionBody;

/**
 * The sections a stored draft carries. A chapter draft body is `{sections: ChapterSection[]}` (the
 * shape `editChapter` files) and a bare array is accepted as the older short form; anything else —
 * a string, a fields-shaped draft, null — yields `[]`, because the caller installs prose only when
 * there is prose to install.
 */
export function revisionBodySections(revision: Revision): ChapterSection[] {
    const body = revisionBody(revision.unit_kind, revision.body);
    const raw = Array.isArray(body.sections) ? (body.sections as unknown[]) : [];
    return raw
        .map((section) => section as Partial<ChapterSection>)
        .filter((section) => typeof section?.text === 'string')
        .map((section, index) => ({
            // A section without an id cannot be addressed by a later edit, so it gets a stable one.
            id: typeof section.id === 'string' && section.id ? section.id : `section_${index + 1}`,
            text: String(section.text),
            origin: section.origin === 'author' ? ('author' as const) : ('writer' as const),
            last_run_ref: section.last_run_ref ?? null,
            last_why: section.last_why
        }));
}

/** The prose fields a stored draft carries, for a Summary or plotline selection (D-22's install). */
export function revisionBodyFields(revision: Revision): Record<string, string | number> {
    const body = revisionBody(revision.unit_kind, revision.body);
    const raw = (body.fields ?? {}) as Record<string, unknown>;
    const fields: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) fields[key] = value;
    }
    return fields;
}

/** A draft a reviewer may read (see `loop/records.ts:isReviewableDraft`). */
const isReviewableDraft = (row: Revision): boolean => row.state === 'drafted' || row.state === 'competing';

/** The reviewable drafts of one unit, newest first (U-13's list). */
export function competingRevisions(
    store: Store,
    storyId: string,
    unitKind: Revision['unit_kind'],
    unitRef: string
): Revision[] {
    return revisionRows(store, storyId).filter(
        (row) => row.unit_kind === unitKind && row.unit_ref === unitRef && isReviewableDraft(row)
    );
}

/** The drafts still awaiting a choice — the ones `selectRevision` deletes (D-22). */
export function pendingRevisions(
    store: Store,
    storyId: string,
    unitKind: Revision['unit_kind'],
    unitRef: string
): Revision[] {
    return competingRevisions(store, storyId, unitKind, unitRef);
}

/**
 * The `pending` draft a Writer may keep writing: only its OWN row is returned (a second write in
 * the same run extends the same draft). A draft another Writer left unfinished is never adopted —
 * L-16's siblings are blind to each other, so each files its own draft, and phase ①'s samples are
 * persisted whole by the engine in a single turn (no partial draft can exist). The classic
 * `summaryCompletionJobs` / `wi_complete_*` adoption path was removed with the sample → screen →
 * select pipeline.
 */
export function pendingDraftFor(
    store: Store,
    storyId: string,
    unitKind: Revision['unit_kind'],
    unitRef: string,
    runId: string | undefined
): Revision | undefined {
    const pending = revisionRows(store, storyId).filter(
        (row) => row.unit_kind === unitKind && row.unit_ref === unitRef && row.state === 'pending'
    );

    return pending.find((row) => row.run_ref === runId);
}

/**
 * Files one draft (D-3d). The run that wrote it owns the row, so `run_ref` rides along and the
 * dashboard can show which agent produced which draft (U-13).
 */
export async function fileRevision(
    ctx: ToolExecutionContext,
    revision: { unit_kind: Revision['unit_kind']; unit_ref: string; body: unknown },
    why: string
): Promise<Revision> {
    const created = await ctx.store.revisions.create(
        {
            story_id: ctx.storyId,
            unit_kind: revision.unit_kind,
            unit_ref: revision.unit_ref,
            body: revision.body,
            // P11: the row names the run that produced the draft. `undefined`, not `null` — the
            // record type leaves the field out rather than storing a null, which is what the
            // store's `RecordInit` accepts.
            run_ref: ctx.runId,
            template_ref: ctx.templateRef,
            // A new draft is `pending` until its Writer's run closes and the loop validates it
            // (§4.15). Readers, checkers and the Editor only ever see `drafted` rows, so a
            // reviewer can no longer read a Summary halfway through its blocks.
            state: 'pending',
            verdict_refs: []
        },
        buildAttribution(ctx, why)
    );
    return created as Revision;
}

/**
 * D-22: the selection installs the winner and clears the other competing drafts in the SAME
 * commit, so a fresh Writer on the next chapter cannot see two texts. `install` does the unit write
 * inside the commit, then the alternatives are dealt with.
 *
 * A Summary pass is the one exception: phase ①'s Overview 1…N tree must keep every Writer sample
 * after the Editor picks one, so those losers are kept as `discarded` rows (`view.revisions`) rather
 * than hard-deleted. Chapter and plotline selection still delete hard, as D-22 requires.
 */
export async function commitSelection(
    ctx: ToolExecutionContext,
    winner: Revision,
    selectionNote: string,
    install: () => void,
    expects: CAS[]
): Promise<{ deleted: string[] }> {
    const { store, storyId } = ctx;
    const why = selectionNote;
    // R1: the sentence the rail shows on every row THIS selection sets aside. `selectionNote` is the
    // Editor's mandatory justification (`whyField: 'selection_note'`, T-2a; the pipeline refuses a
    // blank one in tools/context.ts:232), so a discarded sample carries the very rule that decided
    // against it rather than an invented one. `selection_note` itself stays the winner's (T-2a).
    const reason = selectionNote.trim();
    let deleted: string[] = [];
    await commitAs(
        ctx,
        'selectRevision',
        async () => {
            install();
            store.revisions.update(
                winner.id,
                { state: 'selected', selection_note: selectionNote },
                buildAttribution(ctx, why)
            );
            const losers = store.revisions.list().filter(
                (row) =>
                    row.story_id === storyId &&
                    row.unit_kind === winner.unit_kind &&
                    row.unit_ref === winner.unit_ref &&
                    // A `pending` sibling goes with the unit's decision too: a half-written draft
                    // cannot be selected later, and leaving it would show the Author a revision
                    // that lost without ever being finished (§4.15).
                    (isReviewableDraft(row) || row.state === 'selected' || row.state === 'pending') &&
                    row.id !== winner.id
            );

            // Phase ① keeps the Author's sampling visible. A Summary selection still installs the
            // winner, but the losing samples are parked as `discarded` instead of being erased: the
            // left rail's Overview 1…N tree is the record of what the Writers actually sampled and
            // what the Readers and the Editor said about each one. Every other unit keeps D-22's
            // hard delete, because a chapter's losers have no second reader in this surface.
            if (winner.unit_kind === 'summary') {
                const loserIds = new Set(losers.map((loser) => loser.id));

                for (const loser of losers) {
                    // R1: the reason is written in the same update that sets the state, so a
                    // `discarded` row can never exist without its explanation (the rail reads the
                    // field, not the journal).
                    store.revisions.update(
                        loser.id,
                        { state: 'discarded', discard_reason: reason },
                        buildAttribution(ctx, why)
                    );
                }

                // A discarded draft is history, not work. Its findings stay in the book (nothing is
                // deleted), but they no longer hold the Summary open or keep a Writer task alive.
                // The kept draft gets its own fresh Readers, which is where a real defect returns.
                const discardedFindings = store.findings
                    .list()
                    .filter(
                        (finding) =>
                            finding.story_id === storyId &&
                            (finding.state === 'unconfirmed' ||
                                finding.state === 'confirmed' ||
                                finding.state === 'approved') &&
                            (finding.related_refs ?? []).some((ref) => loserIds.has(ref))
                    );

                for (const finding of discardedFindings) {
                    store.findings.update(
                        finding.id,
                        { state: 'discarded' },
                        buildAttribution(ctx, `${why} · ${finding.id} was filed against a discarded draft`)
                    );

                    for (const task of store.tasks.list()) {
                        if (task.story_id !== storyId || task.finding_ref !== finding.id) continue;
                        if (task.state !== 'open' && task.state !== 'claimed') continue;

                        store.tasks.update(
                            task.id,
                            { state: 'wontfix' },
                            buildAttribution(ctx, `${why} · ${finding.id} is history on a discarded draft`)
                        );
                    }
                }

                // A merge request is answered by this choice. A rewrite request is the Author's
                // "another round" and survives the choice — the next round starts from this winner.
                for (const task of store.tasks.list()) {
                    if (task.story_id !== storyId) continue;
                    if (task.kind !== 'merge') continue;
                    if (task.state !== 'open' && task.state !== 'claimed') continue;
                    if (task.detail?.includes(winner.unit_ref) !== true && !task.title.includes(winner.unit_ref)) continue;

                    store.tasks.update(
                        task.id,
                        { state: 'wontfix' },
                        buildAttribution(ctx, `${why} · the selection answered this ${task.kind} request`)
                    );
                }
            } else {
                deleted = losers.map((row) => row.id);
                for (const loser of losers) store.revisions.delete(loser.id, buildAttribution(ctx, why));
            }
        },
        expects
    );
    return { deleted };
}

// ── §4.16 proposals (P9/D-20) ───────────────────────────────────────────────

/**
 * Files a proposal instead of writing (P9's Author span, L-7's locked plotline, D-20's locked
 * Summary). The proposal IS the record of the intent, and the Author accepts or rejects it.
 */
export async function fileProposal(
    ctx: ToolExecutionContext,
    proposal: { target_ref: string; target_field: string; patch: unknown },
    why: string
): Promise<Proposal> {
    const created = await ctx.store.proposals.create(
        {
            story_id: ctx.storyId,
            target_ref: proposal.target_ref,
            target_field: proposal.target_field,
            patch: proposal.patch,
            why,
            // P11: the proposal names the run that filed it (see `fileRevision`).
            run_ref: ctx.runId,
            state: 'pending'
        },
        buildAttribution(ctx, why)
    );
    return created as Proposal;
}

/** The prose a proposal's `why` carries, so the Author sees which rule diverted the write. */
export function proposalWhy(rule: string, reason: string): string {
    return `${reason} (rule ${rule}: this write was propose-only, so it is filed for the Author)`;
}

// ── §4.7 tasks (D-11/D-13/T-12) ─────────────────────────────────────────────

/** §4.7's free-text `kind` values this wave files; P15 keeps the union open on purpose. */
export type TaskKind =
    | 'fix'
    | 'merge'
    | 're_brief'
    | 'escalation'
    | 'signoff'
    | 'digest_gap'
    | 'capability_gap'
    | 'directive';

/** An open task with the same kind and title — the dedupe key (T-24/L-15a's no-progress signal). */
export function findOpenTask(store: Store, storyId: string, kind: TaskKind, title: string): Task | undefined {
    return taskRows(store, storyId).find(
        (row) => row.kind === kind && row.title === title && (row.state === 'open' || row.state === 'claimed')
    );
}

/**
 * Opens a task unless an equivalent one is already open, which is what stops a checker running
 * in a fresh context every turn (P2) from filling the queue with the same request.
 */
export function openTask(
    store: Store,
    storyId: string,
    task: {
        kind: TaskKind;
        title: string;
        detail?: string;
        owner_role?: string;
        criterion_ref?: string;
        finding_ref?: string;
        priority?: number;
    },
    attribution: { run_ref?: string | null; author?: boolean; assistant?: boolean; why: string }
): { task: Task; reused: boolean } {
    const existing = findOpenTask(store, storyId, task.kind, task.title);
    if (existing) return { task: existing, reused: true };
    const created = store.tasks.create(
        {
            story_id: storyId,
            kind: task.kind,
            title: task.title,
            detail: task.detail ?? '',
            owner_role: task.owner_role,
            state: 'open',
            priority: task.priority ?? 0,
            criterion_ref: task.criterion_ref,
            finding_ref: task.finding_ref,
            attempts: 0
        },
        attribution
    );
    return { task: created as Task, reused: false };
}

/** A task's `owner_role`, defaulted from the work's nature so the sweep can pick it up (§6.1). */
export function ownerFor(role: string | undefined, fallback: 'writer' | 'editor' | 'checker' | 'author'): string {
    return role && role.trim() ? role.trim() : fallback;
}

// ── chapters + sections (D-7/T-2) ───────────────────────────────────────────

/** The sections an Author wrote, whose spans agents may not rewrite (P9/T-2). */
export function authorSectionIds(chapter: Chapter): string[] {
    return chapter.sections.filter((section) => section.origin === 'author').map((section) => section.id);
}

/** One chapter's section, by id, or the shared not-found refusal (P11's line-range edit). */
export function findSection(chapter: Chapter, sectionId: string): ChapterSection | undefined {
    return chapter.sections.find((section) => section.id === sectionId);
}

/** Replaces one section's text, keeping its `origin` unless the Author wrote it (T-2). */
export function replaceSection(
    chapter: Chapter,
    sectionId: string,
    text: string,
    runRef?: string,
    why?: string
): ChapterSection[] {
    return chapter.sections.map((section) =>
        section.id === sectionId && section.origin !== 'author'
            ? { ...section, text, last_run_ref: runRef ?? null, last_why: why ?? section.last_why }
            : section
    );
}

/**
 * The section a whole-chapter rewrite becomes (D-7): one writer-owned section carrying the new
 * prose, with the Author's spans left out because P9 refuses a rewrite that would drop them.
 */
export function rewriteSections(chapter: Chapter, body: string, runRef?: string, why?: string): ChapterSection[] {
    const preserved = chapter.sections.filter((section) => section.origin === 'author');
    const blocks = body
        .split('\n\n')
        .map((block) => block.trim())
        .filter(Boolean);
    const written: ChapterSection[] = (blocks.length ? blocks : ['']).map((text, index) => ({
        id: index === 0 ? 'section_1' : `section_${index + 1}`,
        text,
        origin: 'writer',
        last_run_ref: runRef ?? null,
        last_why: why
    }));
    return [...written, ...preserved];
}

/** The 1-based line offsets `readChapter` reports, so the next edit's span is known (P11). */
export function sectionOffsets(
    sections: ChapterSection[]
): Array<ChapterSection & { from_line: number; to_line: number }> {
    let cursor = 0;
    return sections.map((section) => {
        // Sections are joined by a blank line (§4.4's derivation), so each one costs its own
        // lines plus the separator, except the first.
        const lines = section.text.split('\n').length;
        const fromLine = cursor + 1;
        const toLine = cursor + lines;
        cursor += lines + 1;
        return { ...section, from_line: fromLine, to_line: toLine };
    });
}

// ── fingerprints (D-16/D-32) ────────────────────────────────────────────────

/** The finding fingerprint, from the fields §4.10 dedupes on. */
export function fingerprintFinding(targetRef: string, criterionRef: string, title: string): string {
    return findingFingerprint(targetRef, criterionRef, title);
}

/** The Idea fingerprint (D-32): decided Ideas are the memory a repeat is checked against. */
export function fingerprintIdea(body: string): string {
    return ideaFingerprint(body);
}

/** An already-DECIDED Idea with the same body — the D-32 repeat check. */
export function decidedIdea(store: Store, storyId: string, body: string): Idea | undefined {
    const fingerprint = fingerprintIdea(body);
    const decided: Idea['state'][] = ['selected', 'discarded', 'deferred'];
    return ideaRows(store, storyId).find(
        (row) =>
            decided.includes(row.state) &&
            (row.fingerprint === fingerprint || fingerprintIdea(row.body) === fingerprint)
    );
}

/** A live finding with the same fingerprint — D-16's dedupe. */
export function duplicateFinding(store: Store, storyId: string, fingerprint: string): Finding | undefined {
    return findingRows(store, storyId).find(
        (row) => row.fingerprint === fingerprint && row.state !== 'fixed' && row.state !== 'discarded'
    );
}

/** A stable fingerprint for a finding whose parts came from separate args (D-16). */
export function stableFingerprint(targetRef: string, criterionRef: string, title: string, detail?: string): string {
    return computeFingerprint(`${targetRef}|${criterionRef}|${title}|${detail ?? ''}`);
}

/** Clips a stored body for a read's payload (T-7). */
export function clipBody(body: string, max: number): string {
    return clip(body, max);
}
