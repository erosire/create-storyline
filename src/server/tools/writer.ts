/**
 * §8.1 — the Writer surface. Eight tools: the Summary, the plotlines, the chapters, the prose,
 * the digest request and the retroactive change proposal.
 *
 * Three rules shape every one of them:
 *  - P5/T-3c — the Summary is writable only in phase `summary` and only while `summary_locked`
 *    is false; after that a Writer files a finding and the Author decides on a backtrack (D-25).
 *  - L-7 — a locked plotline is propose-only, so the write arrives as a §4.16 proposal.
 *  - P9/T-2 — an Author-written section may not be rewritten; it becomes a proposal the Author
 *    accepts or rejects.
 * And D-3d/D-21: in a diverging Story the prose lands as a competing `revisions` row that the
 * Editor selects between, never straight into the chapter.
 */
import type { Chapter, Plotline, Revision, Summary } from '../../shared/types';
import {
    authorSectionIds,
    chapterRows,
    commitSelection,
    competingRevisions,
    fileProposal,
    fileRevision,
    findSection,
    hasOpenFindings,
    isDivergenceMode,
    mustResolveRef,
    plotlineRows,
    proposalWhy,
    replaceSection,
    resolvedChapter,
    resolvedPlotline,
    resolvedSummary,
    rewriteSections,
    summaryRow,
    revisionBodyForUnit,
    type ResolvedRef
} from './artifacts';
import { guardAuthorSpans, guardPlotlineWritable, guardSummaryWritable } from './permissions';
import { arr, bool, enumOf, EXPECTS_ARG, num, obj, str, whyArg, type PropertySchema } from './schema';
import {
    artifactRef,
    buildAttribution,
    chapterText,
    clip,
    commitAs,
    computeFingerprint,
    expectsOf,
    idOf,
    nowIso,
    ok,
    phaseIndex,
    refOf,
    repeatResult,
    revOf,
    scopedRows,
    summarize,
    ToolRefusal,
    wordCount,
    whyOf
} from './utilities';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from './types';

/** §4.2's prose fields — the Writer's whole canvas in phase ① (D-3b excludes `chapter_count`). */
const SUMMARY_FIELDS = ['premise', 'promise', 'theme', 'tone', 'ending', 'world_rules'] as const;

/** §4.3's fields the Writer may set (D-1 keeps `aligned`/`needs_recheck`/`contract_locked` engine-owned). */
const PLOTLINE_FIELDS = ['heading', 'order', 'must_happen', 'must_change', 'pov', 'setups', 'payoffs'] as const;

/** §4.4's fields the Writer may set (state is the engine's, D-1). */
const CHAPTER_FIELDS = ['title', 'summary'] as const;

/** Pulls the declared writable fields out of an arg object, ignoring guards and prose keys. */
function pickFields(args: Record<string, unknown>, fields: readonly string[]): Record<string, string | number> {
    const picked: Record<string, string | number> = {};
    for (const field of fields) {
        const value = args[field];
        if (typeof value === 'string' && value.trim()) picked[field] = value;
        if (typeof value === 'number' && Number.isFinite(value)) picked[field] = Math.trunc(value);
    }
    return picked;
}

/** Refuses when the call named none of the writable fields — an empty write is a lost turn. */
function requireFields(fields: Record<string, string | number>, names: readonly string[], argName = 'field'): string {
    if (Object.keys(fields).length > 0) return '';
    return `no writable field was sent; ${argName} accepts ${names.join(', ')}`;
}

// ── editSummary (D-3/T-3c/P5) ───────────────────────────────────────────────

/**
 * §8.1 `editSummary`: writes the Summary's prose fields. `chapter_count` is Author truth and is
 * not in the schema at all, so a Writer that sends it is refused naming T-11 with the accepted
 * field set (D-3b: "it cannot touch `chapter_count`").
 */
const editSummary: ToolDefinition = {
    name: 'editSummary',
    description:
        "Write the Summary's prose fields — premise, promise, theme, tone, ending, world_rules. Available in phase `summary` only, and only until the Author locks it; after the lock the Summary is read-only for every agent and a change needs a backtrack.",
    inputSchema: {
        type: 'object',
        properties: {
            premise: str("What the story is about, in the Author's terms."),
            promise: str('What the reader is being promised.'),
            theme: str('What the story is about underneath.'),
            tone: str('Voice, POV, tense and register — the sheet C-12/C-13 are checked against.'),
            ending: str('How it ends.'),
            world_rules: str('What is true in the world.'),
            expects: EXPECTS_ARG,
            why: whyArg()
        },
        required: ['why']
    },
    writes: 'summaries',
    level: 'write',
    primaryArg: 'premise',
    mutating: true,
    expectsArg: true,
    requires: ['why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const guard = guardSummaryWritable(ctx, editSummary);
        if (guard) throw guard;

        const fields = pickFields(ctx.args, SUMMARY_FIELDS);
        const missing = requireFields(fields, SUMMARY_FIELDS, 'editSummary');
        if (missing)
            throw new ToolRefusal('T-11', missing, {
                expected_fields: SUMMARY_FIELDS,
                fix: 'send at least one prose field'
            });

        const why = whyOf(ctx);
        const existing = summaryRow(ctx.store, ctx.storyId);

        // D-3d/D-21/§15 step 1: in a diverging Story the Summary competes instead of installing. The
        // Writer role prompt says it plainly ("you are one of several Writers holding the same brief
        // in parallel"), and `writer-summary` sets `attempts: 3` (templates.ts:102, "Phase 1 gets MORE
        // divergence than a chapter, not less"), so the three drafts have to land as `revisions` for
        // the Editor to `selectRevision` between them. Writing in place here made the third attempt
        // overwrite the first and left the Editor nothing to choose — the same reason `editChapter`
        // files a draft (writer.ts:585). The Summary row is the unit, because that is what the loop's
        // phase-① Work Item names (loop/work.ts:phaseUnits) and what `installDraft` writes back
        // (editor.ts:274). Without a Summary row there is no unit to draft against, so the first write
        // of the phase still creates it.
        if (existing !== undefined && isDivergenceMode(ctx.store, ctx.story)) {
            const revision = await fileRevision(
                ctx,
                { unit_kind: 'summary', unit_ref: existing.id, body: { fields } },
                why
            );
            const drafts = competingRevisions(ctx.store, ctx.storyId, 'summary', existing.id);

            return ok(
                {
                    id: revision.id,
                    summary_id: existing.id,
                    draft: true,
                    competing: drafts.length,
                    current_rev: existing.rev,
                    next: `An Editor selects between ${drafts.length} Summary draft${drafts.length === 1 ? '' : 's'} with listRevisions + selectRevision; the Summary still holds the previous text.`
                },
                existing.rev,
                `Summary draft filed (${revision.id})`,
                { revision_id: revision.id }
            );
        }

        const written = (await commitAs(
            ctx,
            'editSummary',
            async () => {
                if (existing)
                    return ctx.store.summaries.update(existing.id, fields, buildAttribution(ctx, why), expects);
                // No Summary record yet: phase ① has to start somewhere, so the first Writer
                // write creates it. `chapter_count` stays 0 — the Author declares it, and C-0
                // fails against 0 until they do (D-3b).
                return ctx.store.summaries.create(
                    { story_id: ctx.storyId, chapter_count: 0, locked: false, ...fields },
                    buildAttribution(ctx, why)
                );
            },
            // A brand-new record cannot be CAS-guarded, so expects applies only to an update.
            existing ? expects : []
        )) as Summary;

        return ok(
            {
                id: written.id,
                fields_written: Object.keys(fields).sort(),
                chapter_count: written.chapter_count,
                locked: written.locked,
                summary_locked: ctx.story.summary_locked,
                current_rev: written.rev,
                next:
                    written.chapter_count === 0
                        ? 'The Author has not declared `chapter_count` yet, so C-0 cannot pass; ask for it in a brief or keep working the prose fields.'
                        : 'Read readSummary to confirm the fields before planning plotlines against them.'
            },
            written.rev,
            `Summary rewritten: ${Object.keys(fields).sort().join(', ')}`
        );
    }
};

// ── plotlines (P4/L-7) ──────────────────────────────────────────────────────

/**
 * §8.1 `createPlotline`: the chapter's contract — what must happen and what must be different
 * afterwards (C-7/C-8). Once `plotlines_locked` is true the write is filed as a proposal (L-7).
 */
const createPlotline: ToolDefinition = {
    name: 'createPlotline',
    description:
        'Create a plotline: the contract one chapter has to satisfy — its heading, order, what must happen, what must change, whose POV it is, and the setups and payoffs it carries.',
    inputSchema: {
        type: 'object',
        properties: {
            heading: str('A short name for the thread.'),
            order: num('The chapter number this contract belongs to (1-based).'),
            must_happen: str('The events the chapter has to deliver (C-7).'),
            must_change: str('What is different at the end: state, knowledge, relationship, position (C-8/C-3).'),
            pov: str('Whose eyes the chapter is told through.'),
            setups: str('Seeds this chapter plants.'),
            payoffs: str('Debts this chapter pays off (C-5/C-6 check these mechanically).'),
            expects: EXPECTS_ARG,
            why: whyArg()
        },
        required: ['heading', 'order', 'must_happen', 'must_change', 'why']
    },
    writes: 'plotlines',
    level: 'write',
    primaryArg: 'heading',
    mutating: true,
    expectsArg: true,
    requires: ['heading', 'order', 'must_happen', 'must_change', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const fields = pickFields(ctx.args, PLOTLINE_FIELDS);
        const order = Math.max(1, Math.trunc(Number(ctx.args.order ?? 0)));
        const why = whyOf(ctx);

        // L-7: after the phase-2 lock the contract is law, so a Writer's change is a proposal.
        const locked = guardPlotlineWritable(ctx, false);
        if (locked === 'propose') {
            const proposal = await fileProposal(
                ctx,
                { target_ref: 'plotlines', target_field: 'create', patch: { ...fields, order } },
                proposalWhy('L-7', 'the plotlines are locked for this Story')
            );
            return ok(
                {
                    proposal_id: proposal.id,
                    id: proposal.id,
                    target_ref: 'plotlines',
                    state: proposal.state,
                    proposed: true,
                    current_rev: ctx.story.rev
                },
                ctx.story.rev,
                `Plotline create filed as proposal ${proposal.id} (L-7)`,
                { proposal_id: proposal.id }
            );
        }

        // P4: one chapter carries one contract, so a duplicate order is a collision, not a
        // second thread. The refusal names the owner so the Writer can edit it instead.
        const clash = plotlineRows(ctx.store, ctx.storyId).find((row) => row.order === order);
        if (clash) {
            throw new ToolRefusal(
                'T-11',
                `plotline order ${order} already belongs to ${clash.id} ("${clash.heading ?? clash.id}") — a chapter has one contract`,
                {
                    order,
                    existing_id: clash.id,
                    expected_kinds: ['plotlines'],
                    fix: `editPlotline ${clash.id}, or use the next free order`
                }
            );
        }

        const created = (await commitAs(
            ctx,
            'createPlotline',
            () =>
                ctx.store.plotlines.create(
                    {
                        story_id: ctx.storyId,
                        order,
                        heading: String(fields.heading ?? ''),
                        must_happen: String(fields.must_happen ?? ''),
                        must_change: String(fields.must_change ?? ''),
                        pov: typeof fields.pov === 'string' ? fields.pov : '',
                        setups: typeof fields.setups === 'string' ? fields.setups : '',
                        payoffs: typeof fields.payoffs === 'string' ? fields.payoffs : '',
                        // Engine-owned flags (D-1): a new contract starts aligned and unchecked.
                        contract_locked: ctx.story.plotlines_locked,
                        aligned: false,
                        needs_recheck: false
                    },
                    buildAttribution(ctx, why)
                ),
            // A create has no prior read of its own, so the guard rides on the Story row:
            // §8 lists `expects` here because appending a contract changes the Story's outline.
            expectsFor(expects, ctx.storyId)
        )) as Plotline;

        return ok(
            {
                id: created.id,
                order: created.order,
                heading: created.heading,
                contract_locked: created.contract_locked,
                current_rev: created.rev,
                next: `Write chapter ${created.order} against this contract with createChapter, or verify the claims first with readIdeas.`
            },
            created.rev,
            `Created plotline ${created.order}: ${created.heading ?? ''}`.trim()
        );
    }
};

/** §8.1 `editPlotline`: one field of one contract (L-7 once locked). */
const editPlotline: ToolDefinition = {
    name: 'editPlotline',
    description:
        'Change one or more fields of a plotline contract. Before the plotlines lock this writes; after it the change is filed as a proposal, because the contract is law by then (L-7).',
    inputSchema: {
        type: 'object',
        properties: {
            plotline_id: str('The plotline to change.'),
            heading: str('A short name for the thread.'),
            order: num('The chapter number this contract belongs to.'),
            must_happen: str('The events the chapter has to deliver.'),
            must_change: str('What is different at the end.'),
            pov: str('Whose eyes the chapter is told through.'),
            setups: str('Seeds this chapter plants.'),
            payoffs: str('Debts this chapter pays off.'),
            expects: EXPECTS_ARG,
            why: whyArg()
        },
        required: ['plotline_id', 'why']
    },
    writes: 'plotlines',
    level: 'write',
    primaryArg: 'plotline_id',
    mutating: true,
    expectsArg: true,
    requires: ['plotline_id', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const target = await mustResolveRef(ctx, ctx.args.plotline_id, 'plotline_id', ['plotlines']);
        const plotline = resolvedPlotline(target);
        const fields = pickFields(ctx.args, PLOTLINE_FIELDS);
        const missing = requireFields(fields, PLOTLINE_FIELDS, 'editPlotline');
        if (missing)
            throw new ToolRefusal('T-11', missing, {
                plotline_id: plotline.id,
                expected_fields: PLOTLINE_FIELDS,
                fix: 'send at least one contract field'
            });

        const why = whyOf(ctx);
        const locked = guardPlotlineWritable(ctx, plotline.contract_locked);
        if (locked === 'propose') {
            const proposal = await fileProposal(
                ctx,
                { target_ref: plotline.id, target_field: Object.keys(fields).join(','), patch: fields },
                proposalWhy(
                    'L-7',
                    `plotline ${plotline.id} is locked (${plotline.contract_locked ? 'its contract is locked' : "the Story's plotlines are locked"})`
                )
            );
            return ok(
                {
                    proposal_id: proposal.id,
                    id: plotline.id,
                    state: proposal.state,
                    proposed: true,
                    current_rev: plotline.rev
                },
                plotline.rev,
                `Plotline ${plotline.id} change filed as proposal ${proposal.id} (L-7)`,
                { proposal_id: proposal.id }
            );
        }

        // A contract change invalidates what was measured against it, but only the engine marks
        // that (L-11a/D-1), so the tool reports it instead of writing `needs_recheck`.
        const written = (await commitAs(
            ctx,
            'editPlotline',
            () => ctx.store.plotlines.update(plotline.id, fields, buildAttribution(ctx, why), expects),
            expects
        )) as Plotline;

        return ok(
            {
                id: written.id,
                order: written.order,
                fields_written: Object.keys(fields).sort(),
                contract_locked: written.contract_locked,
                needs_recheck: written.needs_recheck,
                current_rev: written.rev,
                next: 'The chapter written against the old contract now reads as stale; the loop marks it (L-11a).'
            },
            written.rev,
            `Plotline ${written.id} fields rewritten: ${Object.keys(fields).sort().join(', ')}`
        );
    }
};

// ── chapters (P4/D-7/D-3d) ──────────────────────────────────────────────────

/**
 * §8.1 `createChapter`: the prose record for one contract. Created unwritten — the prose goes
 * through `editChapter`, which is where the section model and the Author's spans apply (D-7).
 */
const createChapter: ToolDefinition = {
    name: 'createChapter',
    description:
        'Create the chapter that belongs to a plotline, with its title and summary. The prose is written afterwards with editChapter, section by section.',
    inputSchema: {
        type: 'object',
        properties: {
            plotline_id: str('The contract this chapter satisfies.'),
            title: str('The chapter title.'),
            summary: str('One-paragraph summary of what the chapter does.'),
            order: num("Chapter number; it defaults to the plotline's order."),
            expects: EXPECTS_ARG,
            why: whyArg()
        },
        // §8.1 lists `summary` with no `?`, and it is not decoration: the Digest is built from the
        // chapter summaries (D-12/D-13), so an empty one is a hole in every later brief. `order`
        // stays optional because §4.3 derives it — a plotline IS its chapter's contract.
        required: ['plotline_id', 'title', 'summary', 'why']
    },
    writes: 'chapters',
    level: 'write',
    primaryArg: 'plotline_id',
    mutating: true,
    expectsArg: true,
    requires: ['plotline_id', 'title', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const target = await mustResolveRef(ctx, ctx.args.plotline_id, 'plotline_id', ['plotlines']);
        const plotline = resolvedPlotline(target);
        const order = ctx.args.order === undefined ? plotline.order : Math.max(1, Math.trunc(Number(ctx.args.order)));
        const why = whyOf(ctx);

        // P4: one contract, one chapter. A second chapter for the same plotline is almost always
        // a mis-read of the outline, so it is refused rather than silently appended.
        const existing = chapterRows(ctx.store, ctx.storyId).find((row) => row.plotline_ref === plotline.id);
        if (existing) {
            throw new ToolRefusal(
                'P4',
                `plotline ${plotline.id} already has chapter ${existing.id} ("${existing.title}") — a chapter carries its contract, and one contract has one chapter`,
                {
                    plotline_id: plotline.id,
                    existing_chapter_id: existing.id,
                    fix: `editChapter ${existing.id}, or create the contract for the chapter you mean`
                }
            );
        }
        const clash = chapterRows(ctx.store, ctx.storyId).find((row) => row.order === order);
        if (clash) {
            throw new ToolRefusal('T-11', `chapter order ${order} is taken by ${clash.id} ("${clash.title}")`, {
                order,
                existing_chapter_id: clash.id,
                fix: `omit order to inherit plotline ${plotline.order}, or edit ${clash.id}`
            });
        }

        const created = (await commitAs(
            ctx,
            'createChapter',
            () =>
                ctx.store.chapters.create(
                    {
                        story_id: ctx.storyId,
                        plotline_ref: plotline.id,
                        order,
                        title: String(ctx.args.title ?? ''),
                        summary: typeof ctx.args.summary === 'string' ? ctx.args.summary : '',
                        // D-7: prose lives in addressable sections; a new chapter has none yet.
                        sections: [],
                        // The initial state, not a transition — the engine owns the rest (D-1).
                        state: 'outlined',
                        author_locked: false,
                        round: 0
                    },
                    buildAttribution(ctx, why)
                ),
            expectsFor(expects, ctx.storyId)
        )) as Chapter;

        return ok(
            {
                id: created.id,
                order: created.order,
                title: created.title,
                plotline_ref: created.plotline_ref,
                state: created.state,
                current_rev: created.rev,
                next: `Write the prose with editChapter ${created.id}; it starts with no sections.`
            },
            created.rev,
            `Created chapter ${created.order}: ${created.title}`
        );
    }
};

/**
 * §8.1 `editChapter`: the prose write. A section edit is the default (D-7); a whole-chapter
 * rewrite needs the explicit `rewrite` flag, because it would otherwise drop sections a
 * reviewer had already tuned. Two outcomes are not writes:
 *  - an Author-written span → a §4.16 proposal (P9/T-2);
 *  - a diverging Story → a competing `revisions` row for the Editor to select (D-3d/D-21).
 */
const editChapter: ToolDefinition = {
    name: 'editChapter',
    description:
        'Write a chapter: replace one section (the default), or the whole chapter with `rewrite`. Title and summary are separate fields. In a diverging Story the prose is filed as a competing draft instead of being installed, and a span the Author wrote becomes a proposal.',
    inputSchema: {
        type: 'object',
        properties: {
            chapter_id: str('The chapter to write.'),
            section_id: str('The section to replace; omit it for a whole-chapter write.'),
            content: str('The new prose for that section, or for the chapter when `rewrite` is true.'),
            rewrite: bool(
                'Set true to replace the whole chapter; without it, `content` with no `section_id` is refused (D-7).'
            ),
            title: str('A new chapter title.'),
            summary: str('A new chapter summary.'),
            expects: EXPECTS_ARG,
            why: whyArg()
        },
        required: ['chapter_id', 'why']
    },
    writes: 'chapters',
    level: 'write',
    primaryArg: 'chapter_id',
    mutating: true,
    expectsArg: true,
    requires: ['chapter_id', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const target = await mustResolveRef(ctx, ctx.args.chapter_id, 'chapter_id', ['chapters']);
        const chapter = resolvedChapter(target);
        const why = whyOf(ctx);
        const content = typeof ctx.args.content === 'string' ? ctx.args.content : undefined;
        const sectionId = ctx.args.section_id ? String(ctx.args.section_id) : '';
        const rewrite = ctx.args.rewrite === true;
        const diverging = isDivergenceMode(ctx.store, ctx.story);

        // D-7: a whole-chapter rewrite is an explicit, separate operation.
        if (content !== undefined && !sectionId && !rewrite) {
            const offsets = chapter.sections.map((section) => section.id);
            throw new ToolRefusal(
                'D-7',
                `a chapter write without section_id would replace the whole chapter, which is a separate operation — send section_id, or send rewrite: true`,
                {
                    chapter_id: chapter.id,
                    field: 'section_id',
                    known_sections: offsets,
                    fix: 'readChapter with sections=true, then edit one section_id'
                }
            );
        }
        const fields = pickFields(ctx.args, CHAPTER_FIELDS);
        if (content === undefined && Object.keys(fields).length === 0) {
            throw new ToolRefusal('T-11', 'editChapter needs content, or a title/summary change', {
                chapter_id: chapter.id,
                expected_fields: ['content', ...CHAPTER_FIELDS],
                fix: 'send content with section_id, or title/summary'
            });
        }

        // P9/T-2: the Author's spans are propose-only.
        const authored = authorSectionIds(chapter);
        const touched = sectionId ? [sectionId] : chapter.sections.map((section) => section.id);
        if (!sectionId && !rewrite) touched.length = 0;
        const span = guardAuthorSpans(ctx, authored, touched, artifactRef('chapters', chapter.id));
        if (span instanceof ToolRefusal) throw span;
        const rewriteHitsAuthorSpan = rewrite && content !== undefined && authored.length > 0;
        if (span === 'propose' || (ctx.role === 'writer' && rewriteHitsAuthorSpan)) {
            const proposal = await fileProposal(
                ctx,
                {
                    target_ref: chapter.id,
                    target_field: sectionId ? 'sections' : 'content',
                    patch: {
                        section_id: sectionId || null,
                        content: content ?? null,
                        drops_author_sections: rewriteHitsAuthorSpan
                    }
                },
                proposalWhy('P9', `chapter ${chapter.id} contains a span the Author wrote (${authored.join(', ')})`)
            );
            return ok(
                {
                    proposal_id: proposal.id,
                    // `id` is the chapter that was touched; `target_ref`/`target_field` say what
                    // the proposal will write when the Author accepts it, so the agent does not
                    // have to re-read §4.16 to know what it just filed.
                    id: chapter.id,
                    target_ref: chapter.id,
                    target_field: sectionId ? 'sections' : 'content',
                    state: proposal.state,
                    proposed: true,
                    locked_sections: authored,
                    current_rev: chapter.rev
                },
                chapter.rev,
                `Chapter ${chapter.order} change filed as proposal ${proposal.id} (P9)`,
                { proposal_id: proposal.id }
            );
        }

        // D-3d/D-21: in a diverging Story the prose competes instead of installing.
        if (diverging && content !== undefined) {
            const sections = rewrite
                ? rewriteSections(chapter, content, ctx.runId, why)
                : replaceSection(chapter, sectionId, content, ctx.runId, why);
            const revision = await fileRevision(
                ctx,
                { unit_kind: 'chapter', unit_ref: chapter.id, body: { sections } },
                why
            );
            const drafts = competingRevisions(ctx.store, ctx.storyId, 'chapter', chapter.id);
            return ok(
                {
                    id: revision.id,
                    chapter_id: chapter.id,
                    draft: true,
                    competing: drafts.length,
                    current_rev: chapter.rev,
                    next: `An Editor selects between ${drafts.length} draft${drafts.length === 1 ? '' : 's'} with listRevisions + selectRevision; the chapter still holds the previous text.`
                },
                chapter.rev,
                `Chapter ${chapter.order} draft filed (${revision.id})`,
                { revision_id: revision.id }
            );
        }

        const written = await commitChapter(ctx, chapter, content, sectionId, rewrite, fields, expects, why);
        const open = hasOpenFindings(ctx.store, ctx.storyId, chapter.id);
        return ok(
            {
                id: written.id,
                order: written.order,
                title: written.title,
                // The write landed in `sections`; `section_id` names WHICH span so the next call
                // in this run can send a valid `expects` and the right `section_id` without
                // re-reading (T-8).
                ...(content === undefined || !sectionId ? {} : { section_id: sectionId }),
                fields_written: [...(content === undefined ? [] : ['sections']), ...Object.keys(fields)],
                word_count: wordCount(chapterText(written)),
                section_count: written.sections.length,
                current_rev: written.rev,
                ...(open
                    ? {
                          open_findings: true,
                          next: `readFindings ${chapter.id}: an open finding is still live against the old text.`
                      }
                    : {
                          // T-6c: the hint names a tool that exists. The Writer cannot verify its own
                          // work; a checker run does that and reports with `submitVerdict`.
                          next: 'Keep working the queue — a checker run judges this chapter and reports with submitVerdict.'
                      })
            },
            written.rev,
            // D-18: the run-log line says what THIS call did, at the granularity the record is
            // edited at, and names the chapter by its number rather than its id.
            content === undefined
                ? `Chapter ${written.order} fields updated`
                : rewrite
                  ? `Chapter ${written.order} rewritten (${written.sections.length} section${written.sections.length === 1 ? '' : 's'})`
                  : `Chapter ${written.order} section ${sectionId} written`
        );
    }
};

/** Applies the prose + field writes in one commit so a title change cannot land without the text. */
async function commitChapter(
    ctx: ToolExecutionContext,
    chapter: Chapter,
    content: string | undefined,
    sectionId: string,
    rewrite: boolean,
    fields: Record<string, string | number>,
    expects: { id: string; rev: number }[],
    why: string
): Promise<Chapter> {
    const written = (await commitAs(
        ctx,
        'editChapter',
        () => {
            const patch: Record<string, unknown> = { ...fields };
            if (content !== undefined) {
                if (rewrite) {
                    patch.sections = rewriteSections(chapter, content, ctx.runId, why);
                } else if (sectionId) {
                    if (!findSection(chapter, sectionId)) {
                        // A section that vanished under the writer is a T-4-style stale read.
                        throw new ToolRefusal(
                            'T-4',
                            `section ${sectionId} is not in chapter ${chapter.id} any more — the chapter changed after you read it`,
                            {
                                chapter_id: chapter.id,
                                section_id: sectionId,
                                known_sections: chapter.sections.map((section) => section.id),
                                fix: 're-read readChapter and re-send with the current section_id and expects'
                            }
                        );
                    }
                    patch.sections = replaceSection(chapter, sectionId, content, ctx.runId, why);
                }
            }
            return ctx.store.chapters.update(chapter.id, patch, buildAttribution(ctx, why), expects);
        },
        expects
    )) as Chapter;
    return written;
}

/** §8.1 `deleteChapter`: refused while a live finding still points at the chapter (D-33). */
const deleteChapter: ToolDefinition = {
    name: 'deleteChapter',
    description:
        'Delete a chapter and its drafts. Refused while a finding is still open against it, because deleting the artifact would close the correction without a decision (D-33).',
    inputSchema: {
        type: 'object',
        properties: {
            chapter_id: str('The chapter to delete.'),
            expects: EXPECTS_ARG,
            why: whyArg()
        },
        required: ['chapter_id', 'why']
    },
    writes: 'chapters',
    level: 'write',
    primaryArg: 'chapter_id',
    mutating: true,
    expectsArg: true,
    requires: ['chapter_id', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const target = await mustResolveRef(ctx, ctx.args.chapter_id, 'chapter_id', ['chapters']);
        const chapter = resolvedChapter(target);
        const ref = artifactRef('chapters', chapter.id);
        const why = whyOf(ctx);

        // Checked before the commit for a cheap refusal, and again inside it, because a checker
        // can raise a finding between the two (D-16).
        if (hasOpenFindings(ctx.store, ctx.storyId, ref)) {
            throw new ToolRefusal(
                'D-33',
                `chapter ${chapter.id} still has an open finding, so deleting it would close the correction with no decision`,
                { chapter_id: chapter.id, fix: `verify or discard it first: readFindings ${chapter.id}` }
            );
        }

        let deletedDrafts = 0;
        await commitAs(
            ctx,
            'deleteChapter',
            async () => {
                if (hasOpenFindings(ctx.store, ctx.storyId, ref)) {
                    throw new ToolRefusal(
                        'D-33',
                        `a finding opened against chapter ${chapter.id} while this delete was in flight, so nothing was deleted`,
                        {
                            chapter_id: chapter.id,
                            fix: `readFindings ${chapter.id} and decide it`
                        }
                    );
                }
                ctx.store.chapters.delete(chapter.id, buildAttribution(ctx, why), expects);
                // A deleted unit cannot keep competing drafts: nothing would select between them.
                deletedDrafts = ctx.store.revisions.deleteWhere(
                    (row) => row.story_id === ctx.storyId && row.unit_kind === 'chapter' && row.unit_ref === chapter.id,
                    buildAttribution(ctx, why)
                );
            },
            expects
        );

        return ok(
            {
                id: chapter.id,
                order: chapter.order,
                deleted: true,
                deleted_drafts: deletedDrafts,
                next: 'Later chapters keep their orders. The Digest still covers what was deleted (D-12a).'
            },
            undefined,
            `Deleted chapter ${chapter.order}${deletedDrafts ? ` and ${deletedDrafts} draft(s)` : ''}`
        );
    }
};

// ── updateDigest (D-12a/D-13) ───────────────────────────────────────────────

/**
 * §8.1 `updateDigest`: registered on every session and refused for every role, because the
 * Digest is derived by the engine (D-12a). Keeping the tool in the catalogue is the point: a
 * Writer that reaches for the Digest gets the rule and the alternative (`digest_gap`, D-13)
 * instead of quietly writing a summary nobody asked for.
 */
const updateDigest: ToolDefinition = {
    name: 'updateDigest',
    description:
        'Ask for the running Digest to be rewritten. Registered everywhere and refused for every role: the engine derives the Digest from committed changes (D-12a), so the crew files a `digest_gap` finding instead (D-13).',
    inputSchema: {
        type: 'object',
        properties: {
            body: str('The text you would have written — carried into the finding so the engine has the note.'),
            expects: EXPECTS_ARG,
            why: whyArg('Why the Digest is stale.')
        },
        // §8.1 lists `body, expects, why` with nothing optional: the text is what rides into the
        // `digest_gap` finding, so a call without it says nothing (T-11).
        required: ['body', 'why']
    },
    // The §7 `digests` row gives every kind `read`, and the row's refusal rules name D-12a, so
    // this is refused by the permission layer before the body is ever looked at.
    writes: 'digests',
    level: 'write',
    mutating: true,
    expectsArg: true,
    requires: ['body', 'why'],
    async execute(ctx): Promise<ToolResult> {
        // Unreachable in practice — the row refuses every kind — but the guard makes the rule
        // explicit so a future §7 edit cannot silently grant the write.
        throw new ToolRefusal(
            'D-12a',
            'the Digest is derived by the engine from committed changes, so no agent may write it',
            {
                story_id: ctx.storyId,
                // U-3a: the call the agent can actually make. §8's `createTask` takes no kind, so the
                // `createTask with kind "digest_gap"` advice this used to give was a dead end — the
                // next call failed T-11 and the gap was never filed. Kept word-for-word identical to
                // the §7 row's `refusal_fix` (permissions.ts), which is what the permission layer
                // actually attaches: this throw is the backstop, not the path.
                fix: 'raiseFinding with criterion_ref "digest_gap" and the reason the Digest is wrong (D-13)'
            }
        );
    }
};

// ── proposeChange (P9/D-20/D-20a) ──────────────────────────────────────────

/** §4 field names per collection, so `target_field` is validated instead of guessed. */
const FIELD_TABLE: Record<string, readonly string[]> = {
    summaries: SUMMARY_FIELDS,
    plotlines: PLOTLINE_FIELDS,
    chapters: [...CHAPTER_FIELDS, 'sections'],
    cast: ['name', 'want', 'need', 'arc', 'voice', 'state_now', 'traits', 'gender'],
    ledger: ['kind', 'subject', 'detail', 'chapter_ref', 'status']
};

/**
 * §8.1 `proposeChange`: the only path into an Author-written span (P9) and the way a Writer
 * asks for a change to something it may not touch. It files a §4.16 proposal — never an edit —
 * and the Author accepts or rejects it (D-20a).
 */
const proposeChange: ToolDefinition = {
    name: 'proposeChange',
    description:
        'Propose a change to a record you may not write, or may not write right now: an Author-written span, a locked contract, the Summary after the lock. It files the proposal; the Author decides.',
    inputSchema: {
        type: 'object',
        properties: {
            target_ref: str('The record to change: a summary, plotline, chapter, cast member or ledger entry.'),
            target_field: str('The field to change; it must be a field that record actually has.'),
            patch: obj('The proposed new value, or a set of field/value pairs.', {
                value: str('The proposed value for `target_field`.'),
                fields: obj('Or several fields at once.', {})
            }),
            why: whyArg()
        },
        required: ['target_ref', 'target_field', 'why']
    },
    writes: 'proposals',
    level: 'write',
    primaryArg: 'target_ref',
    mutating: true,
    requires: ['target_ref', 'target_field', 'why'],
    async execute(ctx): Promise<ToolResult> {
        const target = await mustResolveRef(ctx, ctx.args.target_ref, 'target_ref', [
            'summaries',
            'plotlines',
            'chapters',
            'cast',
            'ledger'
        ]);
        const field = String(ctx.args.target_field ?? '').trim();
        const allowed = FIELD_TABLE[target.collection] ?? [];
        const fields = field
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean);
        const unknown = fields.filter((name) => !allowed.includes(name));
        if (!fields.length || unknown.length) {
            throw new ToolRefusal(
                'T-11',
                `"${field}" is not a writable field of ${target.collection} — its writable fields are ${allowed.join(', ')}`,
                {
                    target_ref: target.id,
                    field: 'target_field',
                    expected_fields: allowed,
                    fix: `propose one of: ${allowed.join(', ')}`
                }
            );
        }

        const why = whyOf(ctx);
        const patch = ctx.args.patch ?? { value: ctx.args.value ?? null };
        // T-24: the same proposal twice is one proposal. The key is the target, the field and the
        // proposed value, so rewording the `why` does not create a second entry for the Author.
        const fingerprint = computeFingerprint(`${target.id}|${fields.join(',')}|${JSON.stringify(patch)}`);
        const duplicate = proposalFingerprintExists(ctx, fingerprint, patch, target.id, fields);
        if (duplicate) {
            return repeatResult(`proposal ${duplicate.id} already asks for the same change`, {
                id: duplicate.id,
                target_ref: duplicate.target_ref,
                target_field: duplicate.target_field,
                state: duplicate.state,
                next: 'the Author already has this proposal; a second copy would only add noise (T-24)'
            });
        }

        const created = await commitAs(ctx, 'proposeChange', () =>
            ctx.store.proposals.create(
                {
                    story_id: ctx.storyId,
                    target_ref: target.id,
                    target_field: fields.join(','),
                    patch: { ...asRecord(patch), __fingerprint: fingerprint },
                    why,
                    run_ref: ctx.runId,
                    state: 'pending'
                },
                buildAttribution(ctx, why)
            )
        );

        return ok(
            {
                id: idOf(created),
                target_ref: target.id,
                target_field: fields.join(','),
                state: 'pending',
                current_rev: revOf(created),
                next: 'The Author accepts or rejects it in the dashboard; nothing changes in the story until they do (D-20a).'
            },
            revOf(created),
            `Proposed change to ${target.id}.${fields.join(',')}`
        );
    }
};

/** Narrows an unknown patch to a record for fingerprinting. */
function asRecord(patch: unknown): Record<string, unknown> {
    return patch && typeof patch === 'object' && !Array.isArray(patch)
        ? (patch as Record<string, unknown>)
        : { value: patch };
}

/**
 * Finds a pending proposal for the same change. The stored fingerprint is the fast path; the
 * value comparison is the fallback for proposals written before the fingerprint existed.
 */
function proposalFingerprintExists(
    ctx: ToolExecutionContext,
    fingerprint: string,
    patch: unknown,
    targetId: string,
    fields: string[]
): { id: string; target_ref: string; target_field: string; state: string } | undefined {
    const pending = scopedRows(ctx.store.proposals.list(), ctx.storyId).filter((row) => row.state === 'pending');
    for (const row of pending) {
        const stored = asRecord(row.patch);
        if (stored.__fingerprint === fingerprint) return row;
        if (
            row.target_ref === targetId &&
            row.target_field === fields.join(',') &&
            JSON.stringify(stripFingerprint(stored)) === JSON.stringify(stripFingerprint(asRecord(patch)))
        )
            return row;
    }
    return undefined;
}

/** Drops the internal fingerprint key so two patches compare by value alone. */
function stripFingerprint(record: Record<string, unknown>): Record<string, unknown> {
    const { __fingerprint, ...rest } = record;
    void __fingerprint;
    return rest;
}

/** Narrows an `expects` list to the entries naming one record, so a create can still be guarded. */
function expectsFor(expects: { id: string; rev: number }[], id: string): { id: string; rev: number }[] {
    return expects.filter((entry) => entry.id === id);
}

/** §8.1 — the Writer surface, in spec order. */
export const writerTools: ToolDefinition[] = [
    editSummary,
    createPlotline,
    editPlotline,
    createChapter,
    editChapter,
    deleteChapter,
    updateDigest,
    proposeChange
];
