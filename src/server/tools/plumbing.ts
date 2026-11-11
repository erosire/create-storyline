/**
 * §8.4 — the shared plumbing surface: the reads every session stands on, the two Writer-only
 * record editors, the self-describing catalogue (T-6c), and `reportGap` (T-12).
 *
 * §8.4's own sentence fixes the shape of this file: "Present on every session — Writer, Editor,
 * Reader, and checker alike. The `edit*` variants are permitted to the Writer only: the tool is
 * registered everywhere, and the server refuses anyone else's call (T-1a)." So nothing here is
 * hidden by role, and the two writes are refused by the §7 row rather than by a special case.
 *
 * Two invariants the whole file holds:
 *  - a read never writes (D-12a: the derived Digest and the default Goal are READ — a read that
 *    wrote a row would put a turn in the audit trail for doing nothing);
 *  - every read is bounded (T-7) and carries the record `rev` it read (T-8), so the next
 *    `expects` is right first time (T-4).
 */
import { BUILT_IN_CRITERIA } from '../../shared/criteria';
import type {
    CastMember,
    Chapter,
    Idea,
    LedgerEntry,
    LedgerKind,
    LedgerStatus,
    Plotline,
    TaskState
} from '../../shared/types';
import type { UpdatePatch } from '../store/store';
import {
    castRows,
    chapterRows,
    currentDigest,
    findingRows,
    goalFor,
    ideaRows,
    ledgerRows,
    mustResolveRef,
    openTask,
    plotlineRows,
    sectionOffsets,
    summaryRow,
    taskRows,
    verdictRows
} from './artifacts';
import { mayCallKind, permissionRowsFor, type PermissionRow } from './permissions';
import {
    COST_ENUM,
    EXPECTS_ARG,
    FINDING_STATE_ENUM,
    IDEA_STATE_ENUM,
    LEDGER_KIND_ENUM,
    LEDGER_STATUS_ENUM,
    PAGE_ARGS,
    PHASE_ENUM,
    RECOMMENDATION_ENUM,
    TASK_STATE_ENUM,
    bool,
    describeToolPayload,
    enumOf,
    num,
    str,
    whyArg
} from './schema';
import {
    buildAttribution,
    chapterText,
    clip,
    commitAs,
    digestHeader,
    ok,
    okPage,
    okValue,
    PAGE_LIMIT,
    parsePageArgs,
    repeatResult,
    revOf,
    summarize,
    ToolRefusal,
    whyOf,
    wordCount
} from './utilities';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from './types';

// ── readSeed (P5/D-3b) ──────────────────────────────────────────────────────

/**
 * §8.4 `readSeed`: the Author's Seed — read-only for every agent at every phase, forever (P5).
 * It is a read of the `stories` row and has no write partner in this file, because the only
 * entity that edits the Seed is the Author (D-3b).
 */
const readSeed: ToolDefinition = {
    name: 'readSeed',
    description:
        "Read the Author's Seed: the idea the Story exists to realise, plus what is already locked. Read-only for every agent at every phase — a change to it is the Author's, never an edit (P5, D-3b).",
    inputSchema: { type: 'object', properties: {}, required: [] },
    writes: 'stories',
    level: 'read',
    mutating: false,
    execute: (ctx): ToolResult => {
        const summary = summaryRow(ctx.store, ctx.storyId);
        return okValue(
            {
                story_id: ctx.storyId,
                title: ctx.story.title,
                // T-7: the Seed is Author prose and can run long; the dashboard holds the rest.
                idea: clip(ctx.story.idea),
                phase: ctx.story.phase,
                status: ctx.story.status,
                status_reason: ctx.story.status_reason,
                pending_kind: ctx.story.pending_kind,
                summary_locked: ctx.story.summary_locked,
                plotlines_locked: ctx.story.plotlines_locked,
                author_stop: ctx.story.author_stop,
                // D-3b: chapter_count is Author truth; a run reads it, it never sets it.
                chapter_count: summary?.chapter_count ?? 0,
                progress: ctx.story.progress,
                blocked_on: ctx.story.blocked_on,
                current_rev: ctx.story.rev
            },
            { rev: ctx.story.rev }
        );
    }
};

// ── readSummary (D-3/D-3b) ──────────────────────────────────────────────────

/**
 * §8.4 `readSummary`: the phase-① artifact — the Writer's only write during phase ① (T-3c) and
 * read-only for everyone once `summary_locked` is true (P5). The read stays open either way: a
 * run that cannot read the contract cannot explain why it fails.
 */
const readSummary: ToolDefinition = {
    name: 'readSummary',
    description:
        'Read the Summary: premise, promise, theme, tone, ending, world_rules, and the declared chapter_count. Every plotline and chapter is measured against it (D-4); it is read-only once locked (P5).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    writes: 'summaries',
    level: 'read',
    mutating: false,
    execute: (ctx): ToolResult => {
        const summary = summaryRow(ctx.store, ctx.storyId);
        if (!summary)
            return okValue(
                {
                    summary: null,
                    story_id: ctx.storyId,
                    phase: ctx.story.phase,
                    summary_locked: ctx.story.summary_locked,
                    chapter_count: 0
                },
                {
                    notes: [
                        'No Summary record exists yet. During phase `summary` a Writer writes it with editSummary; the Author declares chapter_count (D-3b).'
                    ]
                }
            );
        return okValue(
            {
                summary: {
                    id: summary.id,
                    chapter_count: summary.chapter_count,
                    premise: summary.premise,
                    promise: summary.promise,
                    theme: summary.theme,
                    tone: summary.tone,
                    ending: summary.ending,
                    world_rules: summary.world_rules,
                    locked: summary.locked
                },
                story_id: ctx.storyId,
                phase: ctx.story.phase,
                // Both flags are reported: `locked` mirrors `summary_locked` (L-7a), and a run
                // that reads only one can be refused by a guard reading the other.
                summary_locked: ctx.story.summary_locked,
                current_rev: summary.rev
            },
            { rev: summary.rev }
        );
    }
};

// ── readIdeas (D-27/D-32) ───────────────────────────────────────────────────

/** The Idea states that mean "a decision has been taken" (D-32's memory set). */
const DECIDED_IDEA_STATES: Idea['state'][] = ['selected', 'discarded', 'deferred'];

/**
 * §8.4 `readIdeas`: what the Readers put forward and how the Editor verified it — INCLUDING the
 * Ideas already selected, discarded or deferred. That inclusion is the point (D-32): a fresh
 * context that cannot see the decided list re-proposes what was already rejected.
 */
const readIdeas: ToolDefinition = {
    name: 'readIdeas',
    description:
        'Read the Ideas: what Readers and the Author put forward, with the Editor verification on each. Includes the ones already selected, discarded or deferred — that list is the memory that stops a fresh context re-proposing a settled point (D-32).',
    inputSchema: {
        type: 'object',
        properties: {
            phase: PHASE_ENUM,
            state: IDEA_STATE_ENUM,
            unit_ref: str('Restrict to Ideas about one artifact (its id).'),
            ...PAGE_ARGS
        },
        required: []
    },
    writes: 'ideas',
    level: 'read',
    mutating: false,
    primaryArg: 'unit_ref',
    execute: (ctx): ToolResult => {
        const { limit, offset } = parsePageArgs(ctx.args, PAGE_LIMIT.medium);
        const phase = typeof ctx.args.phase === 'string' ? ctx.args.phase : undefined;
        const state = typeof ctx.args.state === 'string' ? ctx.args.state : undefined;
        const unitRef = typeof ctx.args.unit_ref === 'string' ? ctx.args.unit_ref.trim() : '';

        const rows = ideaRows(ctx.store, ctx.storyId).filter(
            (idea) =>
                (!phase || idea.phase === phase) &&
                (!state || idea.state === state) &&
                (!unitRef || idea.unit_ref === unitRef)
        );
        const page = rows.slice(offset, offset + limit).map((idea) => ({
            id: idea.id,
            phase: idea.phase,
            unit_ref: idea.unit_ref ?? '',
            body: clip(idea.body, 2000),
            kind: idea.kind,
            author: idea.author,
            state: idea.state,
            // D-32: a repeat sighting of a decided Idea is reported, never re-opened.
            decided: DECIDED_IDEA_STATES.includes(idea.state),
            seen_count: idea.seen_count,
            // T-10: a claim reaches a locked artifact only with its citations attached, so the
            // citation is shown with the claim it supports.
            sources: idea.sources.map((source) => ({
                url_or_title: source.url_or_title,
                claim: clip(source.claim, 300),
                accessed_at: source.accessed_at
            })),
            // D-27/D-31: the Editor's two independent answers, or null while unchecked.
            verification: idea.verification ?? null,
            absorbed_into: idea.absorbed_into ?? '',
            rev: idea.rev
        }));
        return okPage(page, { total: rows.length, limit, offset });
    }
};

// ── readPlotline (P4/P9) ────────────────────────────────────────────────────

/** The outline shape a Writer plans against: the contract fields plus their standing. */
function plotlineView(plotline: Plotline): Record<string, unknown> {
    return {
        id: plotline.id,
        order: plotline.order,
        heading: plotline.heading ?? '',
        chapter_ref: plotline.chapter_ref ?? '',
        must_happen: plotline.must_happen ?? '',
        must_change: plotline.must_change ?? '',
        pov: plotline.pov ?? '',
        setups: plotline.setups ?? '',
        payoffs: plotline.payoffs ?? '',
        contract_locked: plotline.contract_locked,
        aligned: plotline.aligned,
        needs_recheck: plotline.needs_recheck,
        rev: plotline.rev
    };
}

/**
 * §8.4 `readPlotline`: `plotline_id` | `order` | `list`. One contract, or the whole outline in
 * order — "the contract the Writer must satisfy" (P9). The order number is honoured by the
 * shared resolver, which is how "chapter 3" works without an id round trip.
 */
const readPlotline: ToolDefinition = {
    name: 'readPlotline',
    description:
        'Read one plotline (by id, by "plotline:N", by order number, or by heading), or the whole outline in order with list:true. The plotline is the contract a chapter has to deliver, so read it before writing prose (P9).',
    inputSchema: {
        type: 'object',
        properties: {
            plotline_id: str('One plotline: its id, its order number, or a unique part of its heading.'),
            order: num('One plotline by chapter order number (1-based).'),
            list: bool('True returns every plotline in order instead of one.')
        },
        required: []
    },
    writes: 'plotlines',
    level: 'read',
    mutating: false,
    primaryArg: 'plotline_id',
    async execute(ctx): Promise<ToolResult> {
        const all = plotlineRows(ctx.store, ctx.storyId);
        const wantsOne = ctx.args.plotline_id !== undefined || ctx.args.order !== undefined;
        if (!wantsOne || ctx.args.list === true) {
            if (!all.length)
                return okValue(
                    { plotlines: [], total: 0, plotlines_locked: ctx.story.plotlines_locked },
                    {
                        notes: [
                            'No plotlines yet. During phase `plotlines` a Writer creates them with createPlotline; the outline is the chapter contract (P4).'
                        ]
                    }
                );
            return okValue({
                plotlines: all.map(plotlineView),
                total: all.length,
                plotlines_locked: ctx.story.plotlines_locked,
                // L-7: a locked outline is law, so a change to it arrives as a proposal.
                next: ctx.story.plotlines_locked
                    ? 'The outline is locked: editPlotline files a proposal instead of writing (L-7).'
                    : undefined
            });
        }

        const byOrder = ctx.args.plotline_id === undefined;
        const ref = byOrder ? String(ctx.args.order) : String(ctx.args.plotline_id);
        const resolved = await mustResolveRef(ctx, ref, byOrder ? 'order' : 'plotline_id', ['plotlines']);
        return okValue(
            {
                plotline: plotlineView(resolved.record as Plotline),
                plotlines_locked: ctx.story.plotlines_locked,
                chapters: chapterRows(ctx.store, ctx.storyId)
                    .filter((chapter) => chapter.plotline_ref === resolved.id)
                    .map((chapter) => ({
                        id: chapter.id,
                        order: chapter.order,
                        state: chapter.state,
                        rev: chapter.rev
                    }))
            },
            { rev: revOf(resolved.record) }
        );
    }
};

// ── readChapter (D-7/T-2/D-12a) ─────────────────────────────────────────────

/**
 * §8.4 `readChapter`: the prose plus "Digest context headers so the agent knows what it is
 * standing on" (D-12a). `content` is DERIVED from `sections` (D-7); the section list carries
 * 1-based line offsets and `origin`, because a writer-owned span is editable in place and an
 * Author-written one is propose-only (P9/T-2).
 */
const readChapter: ToolDefinition = {
    name: 'readChapter',
    description:
        'Read one chapter: its prose as sections with line offsets and origin, the Digest header, and the plotline contract it must satisfy. sections:false returns the derived content string with no section list.',
    inputSchema: {
        type: 'object',
        properties: {
            chapter_id: str('The chapter: its id, its order number, or a unique part of its title.'),
            sections: bool('False returns only the derived content string (default true).')
        },
        required: ['chapter_id']
    },
    writes: 'chapters',
    level: 'read',
    mutating: false,
    primaryArg: 'chapter_id',
    requires: ['chapter_id'],
    async execute(ctx): Promise<ToolResult> {
        const resolved = await mustResolveRef(ctx, ctx.args.chapter_id, 'chapter_id', ['chapters']);
        const chapter = resolved.record as Chapter;
        const includeSections = ctx.args.sections !== false;
        const plotline = chapter.plotline_ref
            ? plotlineRows(ctx.store, ctx.storyId).find((row) => row.id === chapter.plotline_ref)
            : undefined;
        const digest = currentDigest(ctx.store, ctx.storyId);
        const content = chapterText(chapter);
        // D-33/D-34: a live finding on this chapter is what the next pass is already supposed to fix.
        const openFindings = findingRows(ctx.store, ctx.storyId).filter(
            (finding) =>
                finding.target_ref === chapter.id && ['unconfirmed', 'confirmed', 'approved'].includes(finding.state)
        );

        return okValue(
            {
                chapter: {
                    id: chapter.id,
                    order: chapter.order,
                    title: chapter.title,
                    summary: chapter.summary ?? '',
                    state: chapter.state,
                    round: chapter.round,
                    last_score: chapter.last_score ?? '',
                    author_locked: chapter.author_locked,
                    current_revision: chapter.current_revision ?? '',
                    bar_override: chapter.bar_override ?? '',
                    word_count: wordCount(content),
                    rev: chapter.rev
                },
                // D-7: the join of the sections, bounded (T-7).
                content: clip(content),
                ...(includeSections
                    ? {
                          sections: sectionOffsets(chapter.sections).map((section) => ({
                              id: section.id,
                              from_line: section.from_line,
                              to_line: section.to_line,
                              // P9/T-2: only a writer-owned span may be rewritten in place.
                              origin: section.origin,
                              text: clip(section.text, 6000),
                              last_run_ref: section.last_run_ref ?? '',
                              last_why: section.last_why ?? ''
                          }))
                      }
                    : {}),
                // D-12a: the standing view, so a fresh run does not rebuild it by hand.
                digest_header: digestHeader(ctx.story, digest, chapterRows(ctx.store, ctx.storyId).length),
                digest_stale: digest?.stale ?? true,
                // P9: the contract, quoted in the same call that returns the prose.
                contract: plotline ? plotlineView(plotline) : null,
                open_findings: openFindings.map((finding) => ({
                    id: finding.id,
                    criterion_ref: finding.criterion_ref,
                    cost: finding.cost
                }))
            },
            { rev: chapter.rev }
        );
    }
};

// ── readCast / editCast (D-9/C-9) ───────────────────────────────────────────

/** §4.5's writable prose fields; `name` is included because a rename is a legitimate edit. */
const CAST_FIELDS = ['name', 'want', 'need', 'arc', 'voice', 'state_now', 'traits', 'gender'] as const;

/**
 * §8.4 `readCast`: the tracked cast sheet. A reviewer checks behaviour against `arc` +
 * `state_now` rather than vibes (D-9/C-9), so both are returned in full.
 */
const readCast: ToolDefinition = {
    name: 'readCast',
    description:
        'Read the cast: want, need, arc, voice, state_now, traits. A reviewer measures behaviour against arc and state_now, so keep state_now current as the story moves (D-9, C-9).',
    inputSchema: { type: 'object', properties: { ...PAGE_ARGS }, required: [] },
    writes: 'cast',
    level: 'read',
    mutating: false,
    execute: (ctx): ToolResult => {
        const { limit, offset } = parsePageArgs(ctx.args, PAGE_LIMIT.medium);
        const rows = castRows(ctx.store, ctx.storyId);
        const page = rows.slice(offset, offset + limit).map((member) => ({
            id: member.id,
            name: member.name,
            want: member.want ?? '',
            need: member.need ?? '',
            arc: member.arc ?? '',
            voice: member.voice ?? '',
            state_now: member.state_now ?? '',
            traits: member.traits ?? '',
            gender: member.gender ?? '',
            rev: member.rev
        }));
        return okPage(page, { total: rows.length, limit, offset });
    }
};

/**
 * §8.4 `editCast`: Writer-only, registered everywhere (T-1a). No `cast_id` creates a member;
 * with one it patches, so the sheet is updated in one call rather than delete-and-recreate.
 * The §7 `cast` row is what refuses an Editor or a checker — there is no role check in here.
 */
const editCast: ToolDefinition = {
    name: 'editCast',
    description:
        'Create or update a cast member: name, want, need, arc, voice, state_now, traits, gender. Writer-only — the rest of the crew reads the sheet and files a finding when the prose contradicts it (C-9).',
    inputSchema: {
        type: 'object',
        properties: {
            cast_id: str('An existing member to update (its id). Omit to create a new one.'),
            name: str('The name a chapter or a finding will use.'),
            want: str('What the character is chasing.'),
            need: str('What the character actually needs.'),
            arc: str('Where the character is expected to move.'),
            voice: str('How the character sounds.'),
            state_now: str('Where the character stands right now (D-9, C-9).'),
            traits: str('Fixed details a reviewer can check.'),
            gender: str('Pronouns or gender, if the story states one.'),
            expects: EXPECTS_ARG,
            why: whyArg('Why the sheet changed (T-5).')
        },
        required: ['why']
    },
    writes: 'cast',
    level: 'write',
    mutating: true,
    expectsArg: true,
    primaryArg: 'cast_id',
    requires: ['why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const fields: Record<string, string> = {};
        for (const field of CAST_FIELDS) {
            const value = ctx.args[field];
            if (typeof value === 'string' && value.trim()) fields[field] = value;
        }
        if (!Object.keys(fields).length)
            throw new ToolRefusal('T-11', 'editCast received none of the cast fields.', {
                field: CAST_FIELDS.join(', '),
                fix: 'send at least one of name, want, need, arc, voice, state_now, traits, gender'
            });

        const why = whyOf(ctx);
        // An explicit id that does not resolve is a refusal (T-3), never a silent create.
        const existing =
            ctx.args.cast_id === undefined
                ? undefined
                : await mustResolveRef(ctx, ctx.args.cast_id, 'cast_id', ['cast']);
        const written = (await commitAs(
            ctx,
            'editCast',
            () =>
                existing
                    ? ctx.store.cast.update(existing.id, fields, buildAttribution(ctx, why), expects)
                    : ctx.store.cast.create(
                          { story_id: ctx.storyId, name: fields.name ?? '', ...fields },
                          buildAttribution(ctx, why)
                      ),
            // A brand-new record has no rev to compare, so `expects` guards only a patch (T-4).
            existing ? expects : []
        )) as CastMember;

        return ok(
            {
                id: written.id,
                name: written.name,
                fields_written: Object.keys(fields).sort(),
                created: !existing,
                current_rev: written.rev
            },
            written.rev,
            `${existing ? 'Updated' : 'Created'} cast member ${written.id}${written.name ? ` (${written.name})` : ''}`
        );
    }
};

// ── readLedger / editLedger (D-10/C-5/C-6) ──────────────────────────────────

/** §4.6's writable fields. */
const LEDGER_FIELDS = ['kind', 'subject', 'detail', 'chapter_ref', 'status'] as const;

/**
 * §8.4 `readLedger`: the continuity facts. C-5 and C-6 are CODE criteria run over this
 * collection (G-3), so an agent's job is to keep the rows accurate — the check itself is not
 * delegated to it.
 */
const readLedger: ToolDefinition = {
    name: 'readLedger',
    description:
        'Read the continuity ledger: setups, payoffs, facts, timeline entries and world rules, each with a subject and a standing. Open setups and conflicts are what C-5/C-6 fail a chapter on, so read this before judging consistency (D-10).',
    inputSchema: {
        type: 'object',
        properties: { kind: LEDGER_KIND_ENUM, status: LEDGER_STATUS_ENUM, ...PAGE_ARGS },
        required: []
    },
    writes: 'ledger',
    level: 'read',
    mutating: false,
    execute: (ctx): ToolResult => {
        const { limit, offset } = parsePageArgs(ctx.args, PAGE_LIMIT.medium);
        const kind = typeof ctx.args.kind === 'string' ? ctx.args.kind : undefined;
        const status = typeof ctx.args.status === 'string' ? ctx.args.status : undefined;
        const rows = ledgerRows(ctx.store, ctx.storyId).filter(
            (entry) => (!kind || entry.kind === kind) && (!status || entry.status === status)
        );
        const page = rows.slice(offset, offset + limit).map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            subject: entry.subject,
            detail: entry.detail ?? '',
            chapter_ref: entry.chapter_ref ?? '',
            status: entry.status,
            // D-10: the key a mechanical contradiction check detects on.
            fingerprint: entry.fingerprint ?? '',
            rev: entry.rev
        }));
        return okPage(page, { total: rows.length, limit, offset });
    }
};

/**
 * §8.4 `editLedger`: Writer-only. `fingerprint` is DERIVED from kind+subject+detail, because it
 * exists to make "the same fact, restated" detectable rather than to be typed by hand (D-10).
 */
const editLedger: ToolDefinition = {
    name: 'editLedger',
    description:
        'Create or update a continuity fact: kind, subject, detail, chapter_ref, status. Writer-only. Marking a setup paid, or a fact in conflict, is what makes C-5/C-6 checkable at all (D-10).',
    inputSchema: {
        type: 'object',
        properties: {
            ledger_id: str('An existing entry to update (its id). Omit to create a new one.'),
            kind: LEDGER_KIND_ENUM,
            subject: str('The shared key a contradiction is detected on (D-10).'),
            detail: str('The fact, in one sentence.'),
            chapter_ref: str('The chapter this was planted or paid off in.'),
            status: LEDGER_STATUS_ENUM,
            expects: EXPECTS_ARG,
            why: whyArg('Why the ledger changed (T-5).')
        },
        required: ['why']
    },
    writes: 'ledger',
    level: 'write',
    mutating: true,
    expectsArg: true,
    primaryArg: 'ledger_id',
    requires: ['why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const fields: Record<string, string> = {};
        for (const field of LEDGER_FIELDS) {
            const value = ctx.args[field];
            if (typeof value === 'string' && value.trim()) fields[field] = value;
        }
        if (!Object.keys(fields).length)
            throw new ToolRefusal('T-11', 'editLedger received none of the ledger fields.', {
                field: LEDGER_FIELDS.join(', '),
                fix: 'send at least one of kind, subject, detail, chapter_ref, status'
            });

        const why = whyOf(ctx);
        const existing =
            ctx.args.ledger_id === undefined
                ? undefined
                : await mustResolveRef(ctx, ctx.args.ledger_id, 'ledger_id', ['ledger']);
        // Merge against the stored row so the fingerprint covers the fact as it will read, not as
        // the patch happened to spell it.
        const merged = { ...(existing?.record as LedgerEntry | undefined), ...fields };
        const fingerprint = `${merged.kind}|${merged.subject}|${(merged.detail ?? '').trim().toLowerCase()}`;
        // The enum fields arrive as validated strings (T-11 ran the schema), so the cast is safe.
        const patch: UpdatePatch<LedgerEntry> = { ...fields, fingerprint };

        const written = (await commitAs(
            ctx,
            'editLedger',
            () =>
                existing
                    ? ctx.store.ledger.update(existing.id, patch, buildAttribution(ctx, why), expects)
                    : ctx.store.ledger.create(
                          {
                              story_id: ctx.storyId,
                              kind: merged.kind as LedgerKind,
                              subject: merged.subject ?? '',
                              detail: merged.detail ?? '',
                              chapter_ref: merged.chapter_ref ?? '',
                              status: merged.status as LedgerStatus,
                              fingerprint
                          },
                          buildAttribution(ctx, why)
                      ),
            existing ? expects : []
        )) as LedgerEntry;

        return ok(
            {
                id: written.id,
                kind: written.kind,
                subject: written.subject,
                status: written.status,
                fingerprint: written.fingerprint,
                created: !existing,
                current_rev: written.rev
            },
            written.rev,
            `${existing ? 'Updated' : 'Created'} ledger entry ${written.id} (${written.kind}: ${summarize(written.subject, 60)})`
        );
    }
};

// ── readDigest (D-12a/D-13/D-14) ────────────────────────────────────────────

/**
 * §8.4 `readDigest`: the standing view the loop derives (D-12a). A stale digest is reported
 * honestly — D-14 says it blocks a review, never a fix — and the repair is a `digest_gap` FINDING,
 * not an agent write (D-13, U-3a: §8's createTask takes no kind, so the finding is the only filing
 * route, and it is the ref the builder reads back as the signal to widen the body).
 */
const readDigest: ToolDefinition = {
    name: 'readDigest',
    description:
        'Read the Digest: the derived standing view of the Story (recap, per-chapter lines, open threads, cast state, recent changes). Only the loop writes it, so a stale or wrong Digest is raised as a digest_gap finding (D-12a, D-13).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    writes: 'digests',
    level: 'read',
    mutating: false,
    execute: (ctx): ToolResult => {
        const digest = currentDigest(ctx.store, ctx.storyId);
        if (!digest)
            return okValue(
                { digest: null, story_id: ctx.storyId, stale: true, digest_rev: ctx.story.digest_rev },
                {
                    notes: [
                        'No digest has been derived for this Story yet. Work from readSeed, readSummary, readPlotline and readChapter, and raise a digest_gap finding if the absence blocks a review (D-13).'
                    ]
                }
            );
        return okValue(
            {
                digest: {
                    id: digest.id,
                    // D-12a/D-14: the journal position this derivation read through — the anchor
                    // the staleness test compares against, and what makes a past digest locatable.
                    journal_seq: digest.journal_seq ?? null,
                    stale: digest.stale,
                    current: digest.current === true
                },
                body: clip(digest.body),
                story_id: ctx.storyId,
                digest_rev: ctx.story.digest_rev,
                current_rev: digest.rev
            },
            {
                rev: digest.rev,
                notes: digest.stale
                    ? [
                          'Rule D-14: this digest is stale. It blocks a review, not a fix — a checker that cannot trust it says so in its verdict instead of inventing one.'
                      ]
                    : undefined
            }
        );
    }
};

// ── readGoals (G-4/L-15) ────────────────────────────────────────────────────

/**
 * §8.4 `readGoals`: the criteria list and the threshold (G-4). §7 gives every kind `read` on
 * `goals, criteria` because a checker cannot soften the bar it is measured against (L-15), so
 * there is no write tool for this collection on the agent surface at all.
 */
const readGoals: ToolDefinition = {
    name: 'readGoals',
    description:
        'Read the Goal: the criteria list, which are hard, the soft threshold, and the loop-detection settings. Every reviewer is measured against this list, and no reviewer may soften it (G-4, L-15).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    writes: 'goals',
    level: 'read',
    mutating: false,
    execute: (ctx): ToolResult => {
        const goal = goalFor(ctx.store, ctx.storyId, ctx.story.phase);
        // A Story with no Goal row is measured against the built-in roster (`defaultGoal`); the
        // read says which list is in force instead of inventing a row (D-12a).
        const hasOwnGoal = ctx.store.goals.list().some((row) => row.story_id === ctx.storyId);
        const criteria = goal.criteria.length ? goal.criteria : BUILT_IN_CRITERIA;
        return okValue(
            {
                goal: {
                    id: goal.id,
                    title: goal.title,
                    threshold_soft: goal.threshold_soft,
                    flat_rounds: goal.flat_rounds,
                    regress_tolerance: goal.regress_tolerance,
                    default_applied: !hasOwnGoal
                },
                criteria: criteria.map((criterion) => ({
                    id: criterion.id,
                    label: criterion.label,
                    question: criterion.question,
                    // G-3: a `code` criterion is mechanical, so arguing with it is wasted effort.
                    checker: criterion.checker,
                    hard: criterion.hard,
                    // G-2: every failure names the smallest change that would satisfy it.
                    fix_hint: criterion.fix_hint
                })),
                hard_count: criteria.filter((criterion) => criterion.hard).length,
                soft_count: criteria.filter((criterion) => !criterion.hard).length,
                note: 'flat_rounds and regress_tolerance are loop-detection settings, not budgets (G-5, E-0).',
                current_rev: goal.rev
            },
            { rev: goal.rev }
        );
    }
};

// ── listTasks (D-11) ────────────────────────────────────────────────────────

/**
 * §8.4 `listTasks`: the queue, highest priority first. "Read blocked entries before working:
 * they are the notes left by other runs" (D-11). Writes are §8.3's `createTask`/`editTask`, so
 * this read mutates nothing.
 */
const listTasks: ToolDefinition = {
    name: 'listTasks',
    description:
        'Read the task queue, highest priority first. Read blocked entries before working: they are the notes other runs left. Writes go through createTask and editTask (D-11).',
    inputSchema: {
        type: 'object',
        properties: {
            state: TASK_STATE_ENUM,
            owner_role: str('Restrict to one owner: writer, editor, reader, checker, or author.'),
            ...PAGE_ARGS
        },
        required: []
    },
    writes: 'tasks',
    level: 'read',
    mutating: false,
    execute: (ctx): ToolResult => {
        const { limit, offset } = parsePageArgs(ctx.args, PAGE_LIMIT.medium);
        const state = typeof ctx.args.state === 'string' ? (ctx.args.state as TaskState) : undefined;
        const owner = typeof ctx.args.owner_role === 'string' ? ctx.args.owner_role.trim() : '';
        const rows = taskRows(ctx.store, ctx.storyId).filter(
            (task) => (!state || task.state === state) && (!owner || task.owner_role === owner)
        );
        const page = rows.slice(offset, offset + limit).map((task) => ({
            id: task.id,
            kind: task.kind,
            title: task.title,
            detail: clip(task.detail ?? '', 1200),
            owner_role: task.owner_role ?? '',
            state: task.state,
            priority: task.priority,
            criterion_ref: task.criterion_ref ?? '',
            finding_ref: task.finding_ref ?? '',
            // L-15: attempts are what make "no progress" visible from inside a run.
            attempts: task.attempts,
            rev: task.rev
        }));
        return okPage(page, { total: rows.length, limit, offset });
    }
};

// ── readVerdicts / readFindings (D-33/D-34) ─────────────────────────────────

/**
 * §8.4 `readVerdicts`: what the last passes concluded, "so a fresh run does not re-litigate a
 * settled point". `target_ref` narrows to one artifact.
 */
const readVerdicts: ToolDefinition = {
    name: 'readVerdicts',
    description:
        "Read the verdicts: each run's pass/fail lines with their evidence and recommendation. Read this before reviewing the same artifact again, so a settled point stays settled.",
    inputSchema: {
        type: 'object',
        properties: {
            target_ref: str('Restrict to verdicts about one artifact (its id).'),
            recommendation: RECOMMENDATION_ENUM,
            ...PAGE_ARGS
        },
        required: []
    },
    writes: 'verdicts',
    level: 'read',
    mutating: false,
    primaryArg: 'target_ref',
    execute: (ctx): ToolResult => {
        const { limit, offset } = parsePageArgs(ctx.args, PAGE_LIMIT.medium);
        const targetRef = typeof ctx.args.target_ref === 'string' ? ctx.args.target_ref.trim() : '';
        const recommendation = typeof ctx.args.recommendation === 'string' ? ctx.args.recommendation : undefined;
        const rows = verdictRows(ctx.store, ctx.storyId).filter(
            (verdict) =>
                (!targetRef || verdict.target_ref === targetRef) &&
                (!recommendation || verdict.recommendation === recommendation)
        );
        const page = rows.slice(offset, offset + limit).map((verdict) => ({
            id: verdict.id,
            target_ref: verdict.target_ref,
            target_kind: verdict.target_kind,
            round: verdict.round,
            hard_pass: verdict.hard_pass,
            soft_count: verdict.soft_count,
            recommendation: verdict.recommendation,
            run_ref: verdict.run_ref ?? '',
            criteria_passed: verdict.criteria_passed.map((line) => ({
                criterion: line.criterion,
                result: line.result,
                // D-15: the evidence is what makes the line citable, so it is kept on the clip.
                evidence: clip(line.evidence, 800),
                finding_ref: line.finding_ref ?? ''
            })),
            rev: verdict.rev
        }));
        return okPage(page, { total: rows.length, limit, offset });
    }
};

/**
 * §8.4 `readFindings`: the defect chain with the state each finding is in — D-33 (a reader or
 * checker finding is `unconfirmed` until an Editor confirms it) and D-34 (the Author approves)
 * are both readable here, which is what stops a fresh run re-raising a settled defect.
 */
const readFindings: ToolDefinition = {
    name: 'readFindings',
    description:
        'Read the findings with their state, cost and evidence. A finding from a reader or checker is unconfirmed until an Editor confirms it, and nothing is fixed until the Author approves (D-33, D-34).',
    inputSchema: {
        type: 'object',
        properties: {
            target_ref: str('Restrict to findings about one artifact (its id).'),
            state: FINDING_STATE_ENUM,
            cost: COST_ENUM,
            ...PAGE_ARGS
        },
        required: []
    },
    writes: 'findings',
    level: 'read',
    mutating: false,
    primaryArg: 'target_ref',
    execute: (ctx): ToolResult => {
        const { limit, offset } = parsePageArgs(ctx.args, PAGE_LIMIT.medium);
        const targetRef = typeof ctx.args.target_ref === 'string' ? ctx.args.target_ref.trim() : '';
        const state = typeof ctx.args.state === 'string' ? ctx.args.state : undefined;
        const cost = typeof ctx.args.cost === 'string' ? ctx.args.cost : undefined;
        const rows = findingRows(ctx.store, ctx.storyId).filter(
            (finding) =>
                (!targetRef || finding.target_ref === targetRef) &&
                (!state || finding.state === state) &&
                (!cost || finding.cost === cost)
        );
        const page = rows.slice(offset, offset + limit).map((finding) => ({
            id: finding.id,
            target_ref: finding.target_ref,
            criterion_ref: finding.criterion_ref,
            title: finding.title,
            detail: clip(finding.detail ?? '', 1500),
            evidence: clip(finding.evidence, 800),
            cost: finding.cost,
            state: finding.state,
            confirmed_by: finding.confirmed_by ?? '',
            approved_by: finding.approved_by ?? '',
            // D-16: a repeat bumped this counter instead of opening a second row.
            seen_count: finding.seen_count,
            // L-11a: the other units the defect touches. Surfaced here so a run reading its own
            // chapter's findings can see a cross-chapter defect is already open rather than
            // re-raising it (the propagation is only real if it is readable).
            related_refs: finding.related_refs ?? [],
            rev: finding.rev
        }));
        return okPage(page, { total: rows.length, limit, offset });
    }
};

// ── listTools / describeTool (T-6c) ─────────────────────────────────────────

/** Whether this session's role may call `def`, using §7 rather than a second copy of the rule. */
function toolAllowed(ctx: ToolExecutionContext, def: ToolDefinition): boolean {
    return mayCallKind(ctx.role, def);
}

/** The §7 row rendered for `describeTool`, so an agent can predict a refusal instead of earning one. */
function permissionRowView(row: PermissionRow): Record<string, unknown> {
    return {
        artifact: row.artifact,
        writer: row.writer,
        editor: row.editor,
        checker: row.checker,
        reader: row.reader,
        rules: row.criterion_refs,
        ...(row.note ? { note: row.note } : {})
    };
}

/**
 * §8.4 `listTools`: "the catalogue this session holds, by name and one-line purpose" (T-6c).
 * Registration is uniform (T-6a), so the answer is the whole list; what is role-specific is which
 * calls the §7 row permits, and that is computed per tool rather than hidden by omission.
 */
const listTools: ToolDefinition = {
    name: 'listTools',
    description:
        'List the tools this session holds, what each one writes, and whether your role may call it. Presence is free (T-6a): the detail question is answered by describeTool.',
    inputSchema: {
        type: 'object',
        properties: {
            kind: enumOf(
                ['writer', 'editor', 'reader', 'checker'],
                'Restrict to the tools one role kind may actually call.'
            ),
            writes: str('Restrict to the tools that touch one collection (for example "chapters" or "tasks").')
        },
        required: []
    },
    // The harness catalogue is the §7 `templates, recipes` row, which every kind may read.
    writes: 'templates',
    level: 'read',
    mutating: false,
    execute: (ctx): ToolResult => {
        const catalogue = ctx.catalogue ?? [];
        const writes = typeof ctx.args.writes === 'string' ? ctx.args.writes.trim() : '';
        const kind = typeof ctx.args.kind === 'string' ? ctx.args.kind : '';

        let rows = catalogue
            .filter((def) => !writes || def.writes === writes)
            .map((def) => ({
                name: def.name,
                purpose: def.description,
                writes: def.writes,
                needs: { expects: def.expectsArg === true, why: def.mutating && def.whyOptional !== true },
                allowed_for_writer: mayCallKind('writer', def),
                allowed_for_editor: mayCallKind('editor', def),
                allowed_for_checker: mayCallKind('checker', def),
                allowed_for_reader: mayCallKind('reader', def),
                allowed_for_this_role: toolAllowed(ctx, def)
            }));
        // `kind` narrows to what that kind may call — how a run checks a handoff is possible
        // before it files a task for another role.
        if (kind)
            rows = rows.filter((row) => {
                const def = catalogue.find((candidate) => candidate.name === String(row.name));
                return def ? mayCallKind(kind as never, def) : false;
            });

        return okValue({
            role: ctx.role,
            role_name: ctx.roleName,
            tools: rows,
            total: rows.length,
            note: 'Every session holds the whole catalogue; the server refuses what your role may not do, naming the rule (T-1a, T-6a).'
        });
    }
};

/**
 * §8.4 `describeTool`: the exact shape of one tool — required fields, enum values, what `expects`
 * carries (T-6c) — plus the §7 row that governs it, which is what makes a refusal predictable
 * instead of a guess (T-11: "cheaper than guessing and being refused").
 */
const describeTool: ToolDefinition = {
    name: 'describeTool',
    description:
        'Describe one tool exactly: required fields, enum values, what expects must carry, and the permission row that governs it. Cheaper than guessing and being refused (T-6c, T-11).',
    inputSchema: {
        type: 'object',
        properties: { name: str('The tool name, exactly as listTools prints it.') },
        required: ['name']
    },
    writes: 'templates',
    level: 'read',
    mutating: false,
    primaryArg: 'name',
    requires: ['name'],
    execute: (ctx): ToolResult => {
        const name = String(ctx.args.name ?? '').trim();
        const catalogue = ctx.catalogue ?? [];
        const def = catalogue.find((candidate) => candidate.name === name);
        if (!def)
            throw new ToolRefusal('T-11', `no tool named "${name}" is registered on this session`, {
                field: 'name',
                // A sample of the real names is the fix; the whole list is what listTools is for.
                similar: catalogue.slice(0, 12).map((candidate) => candidate.name),
                fix: 'call listTools for the full catalogue'
            });

        const rows = permissionRowsFor(def.writes);
        return okValue({
            ...describeToolPayload(def),
            permission_rows: rows.map(permissionRowView),
            may_call_as_this_role: toolAllowed(ctx, def),
            rule_ids: [...new Set(rows.flatMap((row) => row.criterion_refs))]
        });
    }
};

// ── reportGap (T-12) ────────────────────────────────────────────────────────

/**
 * §8.4 `reportGap`: "this brief asks for something no tool reaches." It writes NO story artifact
 * — it files a `capability_gap` task on the Author's queue, because "a gap is a defect in the
 * build, not in the crew" (T-12). Distinct from `requestAuthor` (§8.3), which asks about the
 * story. Deduped by kind+title so five fresh contexts reporting one gap produce one queue entry.
 */
const reportGap: ToolDefinition = {
    name: 'reportGap',
    description:
        'Report that this brief asks for something no tool can do: name the job, what you needed, and what you did instead. It files a capability_gap task for the Author and writes no story artifact (T-12).',
    inputSchema: {
        type: 'object',
        properties: {
            job: str('The job your brief asked for, in one line.'),
            needed: str('The capability you needed to do it.'),
            tried: str('What you did instead, so the improvisation is on the record.'),
            tool: str('A tool that almost covers it, if one exists.'),
            why: whyArg('Why the surface cannot reach this job (T-12).')
        },
        required: ['job', 'needed', 'tried', 'why']
    },
    writes: 'tasks',
    level: 'write',
    mutating: true,
    primaryArg: 'job',
    requires: ['job', 'needed', 'tried', 'why'],
    async execute(ctx): Promise<ToolResult> {
        const job = summarize(String(ctx.args.job ?? ''), 200);
        const why = whyOf(ctx);
        const detail = [
            `Job: ${String(ctx.args.job ?? '')}`,
            `Needed: ${String(ctx.args.needed ?? '')}`,
            `Did instead: ${String(ctx.args.tried ?? '')}`,
            ctx.args.tool ? `Closest tool: ${String(ctx.args.tool)}` : '',
            `Why: ${why}`,
            `Role: ${ctx.roleName || ctx.role} · run ${ctx.runId ?? 'none'}`
        ]
            .filter(Boolean)
            .join('\n');

        const filed = await commitAs(
            ctx,
            'reportGap',
            () =>
                openTask(
                    ctx.store,
                    ctx.storyId,
                    { kind: 'capability_gap', title: job, detail, owner_role: 'author', priority: 60 },
                    buildAttribution(ctx, why)
                ),
            []
        );

        const data = {
            job,
            needed: String(ctx.args.needed ?? ''),
            tried: String(ctx.args.tried ?? ''),
            task_id: filed.task.id,
            owner_role: 'author'
        };
        if (filed.reused)
            return repeatResult(`Capability gap already queued as ${filed.task.id}`, data, {
                task_id: filed.task.id,
                message:
                    'Rule: T-12 — this gap is already on the Author queue, and the Story is not penalised for the shortfall.'
            });
        return ok(data, revOf(filed.task), `Capability gap filed as ${filed.task.id}`, { task_id: filed.task.id });
    }
};

// ── exports ─────────────────────────────────────────────────────────────────

/** §8.4's seventeen tools, in the order the spec lists them. */
export const plumbingTools: ToolDefinition[] = [
    readSeed,
    readSummary,
    readIdeas,
    readPlotline,
    readChapter,
    readCast,
    editCast,
    readLedger,
    editLedger,
    readDigest,
    readGoals,
    listTasks,
    readVerdicts,
    readFindings,
    listTools,
    describeTool,
    reportGap
];
