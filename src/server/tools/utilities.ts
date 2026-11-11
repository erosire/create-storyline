/**
 * Pure helpers for the §8 tool surface: refusals, result builders, the commit/CAS wrapper,
 * fingerprinting, clipping, pagination and the env/fetch plumbing §8.5 needs.
 *
 * Store-backed helpers (ref resolution, row reads, revision/proposal/task writes) live in
 * `artifacts.ts`, which imports this module — so nothing here imports back. Spec ids in
 * comments point at `documents/specifications.md`.
 */
import { chapterContent } from '../../shared/chapter';
import type { ToolSchema } from '../llm/client';

/**
 * The dashboard's Story routes (U-2), used only in `next:` hints. The route table lives with the
 * dashboard (W5/W6 own it); this layer names the prefix it believes in, and nothing outside a
 * hint string depends on it, so a route change is a string edit here and nowhere else.
 */
const DASHBOARD_URL_BASE = '/story/';
import type { Chapter, ChapterSection, CollectionName, Digest, Story } from '../../shared/types';
import type { Attribution, CAS } from '../store/store';
import type { ToolExecutionContext, ToolResult } from './types';

/** Re-exported so a tool module imports its whole helper set from one place. */
export type { ToolSchema };

// ── refusals (T-1a/T-11) ────────────────────────────────────────────────────

/** Refusal families the run layer's mirror classifies (see `RunToolResult.refused`). */
export type ToolRefusalReason =
    | 'permission'
    | 'invalid_args'
    | 'cas_conflict'
    | 'missing_why'
    | 'not_found'
    | 'unknown_tool'
    | 'unknown_role'
    | 'incomplete';

/**
 * Thrown by a guard or a tool body to abort a call. The pipeline renders it as a result that
 * names the rule and the artifact (T-1a: "the refusal is a teaching message inside the run"),
 * and a throw inside `Store.commit` rolls the writes back, so a refusal means nothing changed.
 */
export class ToolRefusal extends Error {
    constructor(
        /** The rule id the message leads with — P10, P5, L-19, T-11, D-12a… (T-1a). */
        readonly rule: string,
        message: string,
        /** Structured hint: the offending field, what was seen, and the read that fixes it. */
        readonly details: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = 'ToolRefusal';
    }
}

/** Builds a refusal result. `refused` carries the rule id for T-1b's per-run tally. */
export function refusalResult(rule: string, message: string, details: Record<string, unknown> = {}): ToolResult {
    return {
        ok: false,
        refused: rule,
        message: `Rule: ${rule} — ${message}`,
        error: `Rule: ${rule} — ${message}`,
        ...details
    };
}

/**
 * Renders the store's `CasConflict` as T-4's result: the write was rejected and the CURRENT
 * records come back so the agent re-reads and re-applies instead of forcing.
 *
 * The conflict is duck-typed rather than `instanceof`: `CasConflict` lives in the persistence
 * module, and the tool layer must not pull `node:fs` into its import graph for one class.
 */
export function isCasConflict(err: unknown): err is { currents: { id: string; record: unknown }[] } {
    return typeof err === 'object' && err !== null && 'currents' in err && !('rule' in err);
}

/** Any thrown value → a tool result. Unknown throws keep their message (never swallowed). */
export function toFailureResult(err: unknown): ToolResult {
    if (err instanceof ToolRefusal) return refusalResult(err.rule, err.message, err.details);
    if (isCasConflict(err)) {
        const currents = err.currents ?? [];
        return {
            ok: false,
            refused: 'T-4',
            cas_conflict: true,
            currents,
            error:
                err instanceof Error && err.message
                    ? err.message
                    : 'Rule: T-4 — the record changed after you read it, so nothing was written',
            message: 'Rule: T-4 — re-read the record and re-send the write with an expects that matches it.'
        };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, message };
}

// ── results ─────────────────────────────────────────────────────────────────

/**
 * A successful write. `rev` is the written record's post-write revision (T-8), `summary` is
 * the one-line string the run log and the dashboard show.
 */
export function ok(
    data: Record<string, unknown>,
    rev?: number,
    summary?: string,
    extra: Record<string, unknown> = {}
): ToolResult {
    return {
        ok: true,
        data,
        ...(rev === undefined ? {} : { rev }),
        ...(summary === undefined ? {} : { summary }),
        ...extra
    };
}

/** A read's payload: no `rev` unless the record has one, no summary. */
export function okValue(data: Record<string, unknown>, extra: Record<string, unknown> = {}): ToolResult {
    return { ok: true, data, ...extra };
}

/** Paged payload; `next` is the following offset or null, so a reader never guesses. */
export function okPage<T>(items: T[], meta: { total: number; limit: number; offset: number }): ToolResult {
    const hasMore = meta.offset + items.length < meta.total;
    return {
        ok: true,
        data: {
            items,
            total: meta.total,
            limit: meta.limit,
            offset: meta.offset,
            next: hasMore ? meta.offset + items.length : null
        }
    };
}

/** An inline list attached to a mutation's result (task queue, competing drafts). */
export function okList<T>(
    items: T[],
    meta: { total: number; limit?: number; offset?: number },
    extra: Record<string, unknown> = {}
): ToolResult {
    return {
        ok: true,
        data: {
            items,
            total: meta.total,
            ...(meta.limit === undefined ? {} : { limit: meta.limit }),
            ...(meta.offset === undefined ? {} : { offset: meta.offset }),
            next: (meta.offset ?? 0) + items.length < meta.total
        },
        ...extra
    };
}

/**
 * T-24/D-16/D-32's repeat contract: the call changed nothing because an equivalent record was
 * already there (or was already DECIDED), and the response names the existing record.
 */
export function repeatResult(
    summary: string,
    data: Record<string, unknown>,
    extra: Record<string, unknown> = {}
): ToolResult {
    return { ok: true, repeat: true, summary, data, ...extra };
}

// ── commit + CAS (T-4/T-5) ──────────────────────────────────────────────────

/**
 * Runs `fn` inside one store commit labelled for the tool, so several writes land as one
 * decision with one audit group (D-22, L-7, D-36). `store.commit` returns nothing, so `fn`'s
 * value is captured here — the tool still gets its written record back.
 *
 * CAS is asserted BEFORE `fn` runs: the store refuses a stale `expects`, and because nothing
 * has been written yet, the rollback path is never needed for the common conflict.
 */
export async function commitAs<T>(
    ctx: Pick<ToolExecutionContext, 'store'>,
    label: string,
    fn: () => T | Promise<T>,
    expects: CAS[] = []
): Promise<T> {
    if (expects.length > 0) ctx.store._assertCas(expects);
    let captured!: T;
    await ctx.store.commit(`tool:${label}`, async () => {
        captured = await fn();
    });
    return captured;
}

/** The written record's `rev`, when a commit result is a record (T-8). */
export function revOf(record: unknown): number | undefined {
    if (typeof record === 'object' && record !== null && 'rev' in record) {
        const value = (record as { rev?: unknown }).rev;
        if (typeof value === 'number') return value;
    }
    return undefined;
}

/** The written record's id, for `data.id`. */
export function idOf(record: unknown): string {
    if (typeof record === 'object' && record !== null && 'id' in record) {
        const value = (record as { id?: unknown }).id;
        if (typeof value === 'string') return value;
    }
    return '';
}

/** id of a record the tool just wrote, falling back to the ref the agent already holds. */
export function refOf(record: { id?: string } | undefined, fallback = ''): string {
    return record && typeof record.id === 'string' ? record.id : fallback;
}

/**
 * Attribution for a write (P11/T-5). `author` stays false — an agent write is not the Author's own
 * edit — and `assistant` mirrors the session, because §8.6's Author-invoked run is the third writer
 * kind §2/D-8 name: "the machine, on the Author's instruction", which the audit must not merge in
 * with a dispatched crew run.
 */
export function buildAttribution(
    ctx: Pick<ToolExecutionContext, 'runId' | 'actorLabel' | 'assistant'>,
    why: string
): Attribution {
    return { run_ref: ctx.runId ?? null, author: false, assistant: ctx.assistant === true, why };
}

/** The `why` a write must carry (T-5), read from `why` or the tool's named substitute. */
export function whyOf(ctx: Pick<ToolExecutionContext, 'args' | 'tool'>): string {
    const field = ctx.tool.whyField ?? 'why';
    const raw = ctx.args[field];
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Reads `expects` into CAS entries (§T-4's array form: `[{id, rev}]`). A single object is
 * accepted too, because that is what one write naturally sends; anything else is a T-11
 * refusal naming the shape rather than a silent no-guard write.
 */
export function expectsOf(args: Record<string, unknown>): CAS[] {
    const raw = args.expects;
    if (raw === undefined || raw === null) return [];
    const entries = Array.isArray(raw) ? raw : [raw];
    return entries
        .map((entry) => {
            const record = (entry ?? {}) as { id?: unknown; rev?: unknown };
            const id = typeof record.id === 'string' ? record.id.trim() : '';
            const rev = Number(record.rev);
            if (!id || !Number.isFinite(rev)) return undefined;
            return { id, rev: Math.trunc(rev) };
        })
        .filter((entry): entry is CAS => entry !== undefined);
}

// ── story scoping (T-3) ─────────────────────────────────────────────────────

/**
 * True for every record shape the store holds (they all carry `story_id`).
 *
 * The helper is deliberately NOT constrained to read `story_id` off the generic: the ref resolver
 * passes `unknown[]` casts of heterogeneous rows (`{id}`, `{order}`), and a weak-type constraint
 * would reject a row shape that legitimately has no `story_id` in the CAST even though every real
 * record carries it. The cast is one line inside this function instead of a constraint that fails
 * on the caller.
 */
function storyIdOf(row: unknown): string | undefined {
    if (typeof row !== 'object' || row === null) return undefined;
    const value = (row as { story_id?: unknown }).story_id;
    return typeof value === 'string' ? value : undefined;
}

/** Filters a collection's whole list down to the current Story (T-3). */
export function scopedRows<T>(rows: T[], storyId: string): T[] {
    return rows.filter((row) => storyIdOf(row) === storyId);
}

/** `get` scoped to the current Story: the store's `get` is global for the dashboard's benefit. */
export function scopedGet<T>(row: T | undefined, storyId: string): T | undefined {
    if (!row) return undefined;
    return storyIdOf(row) === storyId ? row : undefined;
}

/** ISO timestamp for records that carry a wall-clock date (D-27's `checked_at`). */
export function nowIso(): string {
    return new Date().toISOString();
}

// ── fingerprints (D-16/D-32) + clipping (T-7) ───────────────────────────────

/** Stable key for a line of text — the dedupe key `findings.fingerprint` and `ideas.fingerprint`. */
export function computeFingerprint(text: string): string {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = (((hash << 5) + hash) ^ text.charCodeAt(i)) | 0;
    return `fp${(hash >>> 0).toString(36)}_${text.length}`;
}

/** Normalises text so quoting or capitalising a claim does not defeat a dedupe. */
export function normalizeForFingerprint(text: string): string {
    return text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s]/g, '')
        .trim();
}

/** The finding fingerprint (D-16): same criterion, same target, same claim → one finding. */
export function findingFingerprint(targetRef: string, criterionRef: string, title: string): string {
    return computeFingerprint(`${targetRef}|${criterionRef}|${normalizeForFingerprint(title)}`);
}

/** The Idea fingerprint (D-32): the body alone, so a re-phrase of a decided Idea still matches. */
export function ideaFingerprint(body: string): string {
    return computeFingerprint(normalizeForFingerprint(body));
}

/** Hard cap for text handed to a model — one huge artifact must not blow a call (T-7). */
export const MAX_CLIP = 12000;

/** Clips to `max` characters and marks the cut. */
export function clip(text: string, max = MAX_CLIP): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}\u2026`;
}

/**
 * Clips to a line range (the section-offset reads in §8.4). Bounds are clamped rather than
 * refused — a truncated read is cheaper to recover from than an error — and `clipped` says
 * that it happened.
 */
export function clipLines(text: string, fromLine?: number, toLine?: number): { text: string; clipped: boolean } {
    const lines = text.split('\n');
    const from = clampIndex(fromLine ?? 0, lines.length);
    const rawTo = toLine === undefined ? undefined : Math.max(from, Math.floor(toLine));
    const to = rawTo === undefined ? lines.length : clampIndex(rawTo, lines.length);
    const slice = lines.slice(from, to).join('\n');
    const bounded = from > 0 || (rawTo !== undefined && rawTo < lines.length);
    if (!bounded) return { text: clip(slice), clipped: slice.length > MAX_CLIP };
    return { text: slice, clipped: slice.length > MAX_CLIP };
}

function clampIndex(value: number, length: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(length, Math.floor(value)));
}

/** First non-empty line, clipped — list previews, digest bullets, task titles. */
export function summarize(text: string, max = 160): string {
    const first = (text.split('\n').find((line) => line.trim().length > 0) ?? '').trim();
    return first.length <= max ? first : `${first.slice(0, max - 1)}\u2026`;
}

/** Words in a prose body — the writer's own progress read, and nothing is scored from it (P6). */
export function wordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
}

/** The sentence around `needle`, so a research hit shows the claim it supports (D-27). */
export function excerptAround(text: string, needle: string, radius = 240): string {
    const haystack = text.replace(/\s+/g, ' ');
    const index = haystack.toLowerCase().indexOf(needle.toLowerCase());
    if (index < 0) return clip(haystack, radius);
    const start = Math.max(0, index - radius);
    const end = Math.min(haystack.length, index + needle.length + radius);
    const prefix = start > 0 ? '\u2026' : '';
    const suffix = end < haystack.length ? '\u2026' : '';
    return clip(`${prefix}${haystack.slice(start, end)}${suffix}`, radius * 2);
}

// ── pagination ──────────────────────────────────────────────────────────────

/** Default page sizes per read shape, so every read has a bounded payload (T-7). */
export const PAGE_LIMIT = { small: 20, medium: 50, large: 200 } as const;

/** Parses `offset`/`limit` with a per-tool default and hard bounds. */
export function parsePageArgs(args: Record<string, unknown>, defaultLimit: number): { limit: number; offset: number } {
    const rawLimit = Number(args.limit ?? defaultLimit);
    const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(PAGE_LIMIT.large, Math.trunc(rawLimit)))
        : defaultLimit;
    const rawOffset = Number(args.offset ?? 0);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
    return { limit, offset };
}

// ── refs + kinds (P10/P18/T-3) ──────────────────────────────────────────────

/** §8's `unit_ref`/`target_ref` shape for a record: its id, which is already `kind_n`. */
export function artifactRef(kind: CollectionName | string, id: string): string {
    return `${kind}:${id}`;
}

/** Splits `kind:id`; a bare ref has `kind === null`. */
export function splitRef(ref: string): { kind: string | null; value: string } {
    const index = ref.indexOf(':');
    if (index <= 0) return { kind: null, value: ref };
    return { kind: ref.slice(0, index), value: ref.slice(index + 1) };
}

/**
 * The collection an id belongs to, from its minted prefix (`cast_member_3` → `cast`).
 * The store mints `${singular}_${n}` from `COLLECTION_SINGULARS`, so the prefix is reliable.
 */
export function collectionOfId(id: string, singulars: Record<string, string>): CollectionName | null {
    const match = /^(.*)_\d+$/.exec(id.trim());
    if (!match) return null;
    const entry = Object.entries(singulars).find(([, singular]) => singular === match[1]);
    return entry ? (entry[0] as CollectionName) : null;
}

/**
 * The kind spelled with the right article, inside an agent-visible sentence. §7's kinds are all
 * lower-case words and one of them starts with a vowel, so a template like `a ${role}` prints
 * "a editor" — the refusal prose is read by the model, and bad grammar in a rule message reads
 * like a paraphrase rather than a quotation of §7.
 */
export function rolePhrase(role: string): string {
    return /^[aeiou]/.test(role) ? `an ${role}` : `a ${role}`;
}

/** Dashboard link for one Story's collection (U-2's routes). */
export function dashboardUrl(storyId: string, collection: CollectionName, id?: string): string {
    return `${DASHBOARD_URL_BASE}${storyId}/${collection}${id ? `/${id}` : ''}`;
}

// ── content + phases (D-7/§6) ───────────────────────────────────────────────

/** The §4.4 `content`, derived — agents read and write `sections`, never the join (D-7). */
export function chapterText(chapter: Chapter): string {
    return chapterContent(chapter);
}

/** Sections joined for a rewrite, keeping the Author's `origin` markers where they survive. */
export function proseSections(body: string, sectionId = 'section_1'): ChapterSection[] {
    // A whole-chapter rewrite becomes ONE writer-owned section; the Author's spans are
    // protected earlier (P9), so they never reach this path.
    return body
        .split('\n\n')
        .filter((block) => block.trim().length > 0)
        .map((block, index) => ({
            id: index === 0 ? sectionId : `${sectionId}_${index + 1}`,
            text: block,
            origin: 'writer' as const
        }));
}

/** §6's phase list, in order — the guard tables and the refusal prose both read this. */
export const STORY_PHASES_ORDER = ['summary', 'plotlines', 'chapters'] as const;

/** A Story whose phase has not reached `chapters` has no prose to edit (P5's phase rule). */
export function phaseIndex(story: Pick<Story, 'phase'>): number {
    return STORY_PHASES_ORDER.indexOf(story.phase);
}

/** D-2a: a completed Story's records are read-only. */
export function isCompleted(story: Pick<Story, 'status'>): boolean {
    return story.status === 'completed';
}

/** P8: the Author pulled the cord, so nothing may be written. */
export function isStopped(story: Pick<Story, 'status' | 'author_stop'>): boolean {
    return story.status === 'stopped' || story.author_stop;
}

/** D-12a: the Digest header a read prepends, so an agent knows what it is standing on. */
export function digestHeader(story: Story, digest: Digest | undefined, chapterCount: number): string {
    const stamp = digest?.updated_at ?? 'never';
    const state = isStopped(story) ? `stopped (${story.status_reason ?? 'author'})` : story.status;
    return `Digest: events up to chapter ${chapterCount}. Story is in phase \`${story.phase}\`, status \`${state}\`. Last derived: ${stamp}.`;
}

// ── research plumbing (§8.5) ────────────────────────────────────────────────

/** Env probe for the search providers; a missing key is data, not an error. */
export function readEnv(name: string): string {
    const value = typeof process === 'undefined' ? undefined : process.env[name];
    return typeof value === 'string' ? value.trim() : '';
}

/** JSON POST — the injected fetch keeps tests offline (D-37's test rule). */
export async function postJson<T>(
    fetchImpl: typeof fetch,
    url: string,
    body: unknown,
    headers: Record<string, string> = {}
): Promise<T> {
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return (await response.json()) as T;
}

/** Plain GET, for `fetchPage`, which reads an author's page rather than an API. */
export async function getText(fetchImpl: typeof fetch, url: string): Promise<string> {
    const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'text/html, text/plain;q=0.9' } });
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return response.text();
}

/** Strips markup to readable text, so `fetchPage` never returns HTML to a model. */
export function htmlToText(html: string): string {
    return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
