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
    'templates'
];

/** A label for one collection, singular, for refusal prose ("that id is a chapter"). */
export function kindLabel(collection: CollectionName): string {
    return COLLECTION_SINGULARS[collection].replace(/_/g, ' ');
}

/** Reads the store's typed collection by name without a per-collection switch. */
export function collectionOf(
    store: Store,
    collection: CollectionName
): { list(): unknown[]; get(id: string): unknown } {
    return store[collection] as unknown as { list(): unknown[]; get(id: string): unknown };
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
    const order = typeof record.order === 'number' ? `#${record.order}` : '';
    const id = typeof record.id === 'string' ? record.id : '';
    return heading || title || name || subject || order || id || kindLabel(collection);
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
    if (
        sniffed &&
        !expect.includes(sniffed) &&
        store[sniffed].get(trimmed) &&
        inStoryScope(sniffed, store[sniffed].get(trimmed), storyId)
    ) {
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
export const ideaRows = (store: Store, storyId: string): Idea[] =>
    [...scopedRows(store.ideas.list(), storyId)].sort(
        (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(b.id)
    );
export const revisionRows = (store: Store, storyId: string): Revision[] =>
    [...scopedRows(store.revisions.list(), storyId)].sort(
        (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(b.id)
    );
export const verdictRows = (store: Store, storyId: string): Verdict[] =>
    [...scopedRows(store.verdicts.list(), storyId)].sort(
        (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(b.id)
    );
export const findingRows = (store: Store, storyId: string): Finding[] =>
    [...scopedRows(store.findings.list(), storyId)].sort(
        (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(b.id)
    );
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

/** Competing drafts for one unit, newest first, whatever their stored state (U-13's list). */
export function competingRevisions(
    store: Store,
    storyId: string,
    unitKind: Revision['unit_kind'],
    unitRef: string
): Revision[] {
    return revisionRows(store, storyId).filter((row) => row.unit_kind === unitKind && row.unit_ref === unitRef);
}

/** The drafts still awaiting a choice — the ones `selectRevision` deletes (D-22). */
export function pendingRevisions(
    store: Store,
    storyId: string,
    unitKind: Revision['unit_kind'],
    unitRef: string
): Revision[] {
    return competingRevisions(store, storyId, unitKind, unitRef).filter((row) => row.state === 'competing');
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
            state: 'competing',
            verdict_refs: []
        },
        buildAttribution(ctx, why)
    );
    return created as Revision;
}

/**
 * D-22: the selection installs the winner and deletes the losers in the SAME commit, so a
 * fresh Writer on the next chapter cannot see two texts. `install` does the unit write inside
 * the commit; the delete follows it.
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
            const losers = store.revisions
                .list()
                .filter(
                    (row) =>
                        row.story_id === storyId &&
                        row.unit_kind === winner.unit_kind &&
                        row.unit_ref === winner.unit_ref &&
                        row.id !== winner.id
                );
            deleted = losers.map((row) => row.id);
            for (const loser of losers) store.revisions.delete(loser.id, buildAttribution(ctx, why));
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
