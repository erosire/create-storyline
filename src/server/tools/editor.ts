/**
 * §8.2 — the Editor surface: the selection pipeline (D-21/D-22/D-23/L-16…L-20) plus the two
 * verification gates (D-27/D-31 for Ideas, D-33/D-34/D-35 for findings).
 *
 * The Editor chooses and never writes prose (L-19). Its defining act is `selectRevision`, which
 * installs one draft and deletes the others in the SAME commit (D-22), so the next chapter's
 * Writer cannot inherit two texts. Every selection carries a `selection_note` naming the rule
 * applied (T-2a) — it is the Author's only window into automated taste (L-17).
 */
import type { Chapter, Finding, Idea, Plotline, Revision, Summary, Verdict } from '../../shared/types';
import {
    chapterRows,
    commitSelection,
    competingRevisions,
    findingRows,
    ideaRows,
    mustResolveRef,
    openTask,
    pendingRevisions,
    resolvedChapter,
    resolvedIdea,
    resolvedPlotline,
    resolvedRevision,
    resolvedSummary,
    revisionBodySections,
    revisionBodyFields
} from './artifacts';
import { arr, bool, COST_ENUM, EXPECTS_ARG, IDEA_STATE_ENUM, num, obj, PHASE_ENUM, str, whyArg } from './schema';
import {
    artifactRef,
    buildAttribution,
    clip,
    commitAs,
    expectsOf,
    idOf,
    nowIso,
    ok,
    okList,
    okPage,
    okValue,
    PAGE_LIMIT,
    parsePageArgs,
    refOf,
    revOf,
    scopedRows,
    summarize,
    ToolRefusal,
    wordCount,
    whyOf
} from './utilities';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from './types';

/** §4.15's unit kinds, in the order the resolver tries them. */
const UNIT_COLLECTIONS = ['summaries', 'plotlines', 'chapters'] as const;

/** The `unit_ref` → `unit_kind` mapping §4.15 uses. */
function unitKindOf(collection: string): Revision['unit_kind'] {
    if (collection === 'summaries') return 'summary';
    if (collection === 'plotlines') return 'plotline';
    return 'chapter';
}

/** Resolves a `unit_ref` to its record and unit kind (D-21's unit). */
async function resolveUnit(ctx: ToolExecutionContext, ref: unknown, argName = 'unit_ref') {
    const target = await mustResolveRef(ctx, ref, argName, [...UNIT_COLLECTIONS]);
    return { target, unitKind: unitKindOf(target.collection) };
}

/** One draft, rendered for a side-by-side read (U-13). */
function draftView(draft: Revision, verdicts: Verdict[]) {
    const body =
        draft.unit_kind === 'chapter'
            ? { sections: revisionBodySections(draft) }
            : { fields: revisionBodyFields(draft) };
    return {
        id: draft.id,
        unit_kind: draft.unit_kind,
        unit_ref: draft.unit_ref,
        state: draft.state,
        run_ref: draft.run_ref ?? null,
        created_at: draft.created_at,
        selection_note: draft.selection_note ?? null,
        // D-21: the drafts are shown WITH the verdicts that scored them, which is how the
        // Editor applies the template's `selection_rules` instead of guessing.
        verdicts: verdicts
            .filter((verdict) => draft.verdict_refs.includes(verdict.id) || verdict.target_ref === draft.unit_ref)
            .map((verdict) => ({
                id: verdict.id,
                round: verdict.round,
                hard_pass: verdict.hard_pass,
                soft_count: verdict.soft_count,
                recommendation: verdict.recommendation
            })),
        ...body
    };
}

// ── the selection pipeline ──────────────────────────────────────────────────

/** §8.2 `listRevisions`: the competing drafts for one unit, with their verdicts (D-21). */
const listRevisions: ToolDefinition = {
    name: 'listRevisions',
    description:
        "List the drafts competing for one unit — the Editor's inbox. Each draft comes with the verdicts that scored it, which is what a selection is made from.",
    inputSchema: {
        type: 'object',
        properties: {
            unit_ref: str('The unit whose drafts to list (summary | plotline | chapter).')
        },
        required: ['unit_ref']
    },
    writes: 'revisions',
    level: 'read',
    primaryArg: 'unit_ref',
    mutating: false,
    requires: ['unit_ref'],
    async execute(ctx): Promise<ToolResult> {
        const { store, storyId } = ctx;
        const { target, unitKind } = await resolveUnit(ctx, ctx.args.unit_ref);
        const drafts = competingRevisions(store, storyId, unitKind, target.id);
        const verdicts = scopedRows(store.verdicts.list(), storyId) as Verdict[];
        return okValue({
            unit_ref: target.id,
            unit_kind: unitKind,
            competing: pendingRevisions(store, storyId, unitKind, target.id).length,
            // T-8: the unit's rev, so a following `selectRevision` can send a valid expects.
            unit_rev: (target.record as { rev?: number }).rev,
            drafts: drafts.map((draft) => draftView(draft, verdicts))
        });
    }
};

/**
 * §8.2 `selectRevision`: installs one draft and deletes the rest in the same commit (D-22).
 * The `selection_note` is mandatory and names the rule applied and what was preferred in each
 * draft (T-2a/L-17) — it doubles as the write's `why` (T-5).
 *
 * THE NOTE IS STORED VERBATIM, AND THE RUN LAYER IS ALLOWED TO LENGTHEN IT (D-38/U-8d): a crew
 * panel appends its dissent to this same field before the winning call reaches here — "2 of 3
 * preferred revision_1; selected revision_2 on the must_happen rule" — so what arrives is the
 * agent's own rule sentence, then `' | '`, then the panel's split
 * (`withDissent`/`dissentSentence` in `src/server/run/panel.ts`). This tool neither truncates nor
 * rewrites it, and it must not start assuming the note is ONLY the agent's sentence: on a panel run
 * the dissent is part of the Author's record of the choice (U-8d).
 *
 * What stays enforced here: the note is REQUIRED and non-empty from the caller (T-2a, and T-5's
 * `whyField`), so appended dissent is never a substitute for the caller's own reasoning — a call
 * whose note is blank before the append is refused, not accepted on the panel's words.
 */
const selectRevision: ToolDefinition = {
    name: 'selectRevision',
    description:
        "Install one draft as the unit's content and record why it won. The other drafts are deleted in the same write, so nothing downstream can inherit two texts.",
    inputSchema: {
        type: 'object',
        properties: {
            unit_ref: str('The unit the draft belongs to (summary | plotline | chapter).'),
            revision_id: str('The winning draft id.'),
            selection_note: str('Required: the rule applied and what this draft has that the others do not (T-2a).'),
            expects: EXPECTS_ARG
        },
        required: ['unit_ref', 'revision_id', 'selection_note']
    },
    writes: 'revisions',
    level: 'write',
    primaryArg: 'unit_ref',
    mutating: true,
    whyField: 'selection_note',
    // §7 gives the Writer `write` on `revisions` because it creates them through `editChapter`;
    // choosing between them is the Editor's job alone (T-3b, D-29), which is the one cell the
    // row cannot express as a level.
    onlyKinds: ['editor'],
    requires: ['unit_ref', 'revision_id', 'selection_note'],
    async execute(ctx, expects): Promise<ToolResult> {
        const { store, storyId } = ctx;
        const { target, unitKind } = await resolveUnit(ctx, ctx.args.unit_ref);
        const winner = resolvedRevision(await mustResolveRef(ctx, ctx.args.revision_id, 'revision_id', ['revisions']));

        // A draft of another unit is the usual wrong-pick mistake: refusing with the unit named
        // is cheaper for the run than installing the wrong text (T-11).
        if (winner.unit_kind !== unitKind || winner.unit_ref !== target.id) {
            throw new ToolRefusal(
                'T-11',
                `revision ${winner.id} is a ${winner.unit_kind} draft of ${winner.unit_ref}, not of ${target.id} — select drafts of the unit you are choosing for`,
                {
                    revision_id: winner.id,
                    unit_ref: target.id,
                    expected_unit: artifactRef(unitKind, target.id),
                    fix: `listRevisions ${target.id}`
                }
            );
        }
        if (winner.state !== 'competing') {
            throw new ToolRefusal(
                'D-22',
                `revision ${winner.id} is already ${winner.state}, so there is nothing left to select`,
                {
                    revision_id: winner.id,
                    state: winner.state,
                    fix: 'listRevisions to see what is still competing, or restore the record as the Author'
                }
            );
        }

        // D-38/U-8d: this may be the agent's sentence PLUS the panel's appended dissent ("… | 2 of 3
        // preferred revision_1; selected revision_2 on the must_happen rule"). Only the outer
        // whitespace comes off, and nothing is truncated: the whole note is the Author's record of
        // how the choice was made (L-17), and the caller's own sentence was already checked
        // non-empty by T-5's `whyField` and T-11's required-arg rule.
        const note = String(ctx.args.selection_note ?? '').trim();
        const installedIds: string[] = [];
        const { deleted } = await commitSelection(
            ctx,
            winner,
            note,
            () => installDraft(ctx, unitKind, target.id, winner, note, expects, installedIds),
            // The unit row is what the selection rewrites, so the guard names it when sent.
            expects.filter((entry) => entry.id === target.id)
        );

        const unitRev = (store[target.collection].get(target.id) as { rev?: number } | undefined)?.rev;
        return ok(
            {
                id: winner.id,
                unit_ref: target.id,
                unit_kind: unitKind,
                deleted_drafts: deleted,
                installed_rev: unitRev,
                selection_note: note,
                // T-6c: the hint names a tool that exists — a checker run reports with
                // `submitVerdict`; the Editor's selection is what makes the single text (D-22).
                next: `A fresh Writer now sees exactly one text for ${target.id}; a checker run judges it and reports with submitVerdict.`
            },
            winner.rev,
            `Selected ${winner.id} for ${target.id}; ${deleted.length} draft${deleted.length === 1 ? '' : 's'} deleted`
        );
    }
};

/**
 * Writes the winning draft into its unit. The three unit kinds store different shapes (§4.15's
 * `body: unknown`), so the install is per kind; the chapter path also records `current_revision`
 * so the Author can see, and restore, what was chosen (D-24).
 */
function installDraft(
    ctx: ToolExecutionContext,
    unitKind: Revision['unit_kind'],
    unitRef: string,
    winner: Revision,
    note: string,
    expects: { id: string; rev: number }[],
    installedIds: string[]
): void {
    const { store } = ctx;
    const attribution = buildAttribution(ctx, note);
    const guard = expects.filter((entry) => entry.id === unitRef);
    if (unitKind === 'chapter') {
        const chapter = store.chapters.get(unitRef) as Chapter | undefined;
        if (!chapter)
            throw new ToolRefusal(
                'T-3',
                `chapter ${unitRef} no longer exists, so the draft has nothing to install into`,
                { unit_ref: unitRef, revision_id: winner.id }
            );
        const sections = revisionBodySections(winner);
        store.chapters.update(unitRef, { sections, current_revision: winner.id }, attribution, guard);
        installedIds.push(unitRef);
        return;
    }
    const fields = revisionBodyFields(winner);
    if (unitKind === 'plotline') {
        store.plotlines.update(unitRef, fields, attribution, guard);
    } else {
        store.summaries.update(unitRef, fields, attribution, guard);
    }
    installedIds.push(unitRef);
}

/**
 * §8.2 `requestMerge`: hands the merge to a Writer — the Editor does not compose prose (L-19).
 * The drafts stay in place until the merge lands, which is what keeps the unit waiting for a
 * selection rather than pretending one happened (D-23).
 */
const requestMerge: ToolDefinition = {
    name: 'requestMerge',
    description:
        'Ask a Writer to merge named drafts into one text, saying which parts to take from each. The drafts stay competing until the merged text is selected.',
    inputSchema: {
        type: 'object',
        properties: {
            unit_ref: str('The unit whose drafts should be merged (summary | plotline | chapter).'),
            revision_ids: arr('The drafts to merge.', str('One draft id.')),
            parts: str('Which parts of which draft to take — the merge brief the Writer works from.'),
            why: whyArg()
        },
        required: ['unit_ref', 'revision_ids', 'parts', 'why']
    },
    writes: 'tasks',
    level: 'write',
    primaryArg: 'unit_ref',
    mutating: true,
    requires: ['unit_ref', 'revision_ids', 'parts', 'why'],
    async execute(ctx): Promise<ToolResult> {
        const { store, storyId } = ctx;
        const { target, unitKind } = await resolveUnit(ctx, ctx.args.unit_ref);
        const requested = (Array.isArray(ctx.args.revision_ids) ? ctx.args.revision_ids : []).map(String);
        if (requested.length < 2) {
            throw new ToolRefusal(
                'T-11',
                'requestMerge needs at least two revision_ids — one draft is already a decision',
                {
                    revision_ids: requested,
                    fix: 'select the single draft instead, or name two or more'
                }
            );
        }
        for (const id of requested) {
            const draft = store.revisions.get(id);
            if (!draft || draft.story_id !== storyId)
                throw new ToolRefusal('T-3', `no draft "${id}" in this Story`, {
                    id,
                    expected_kinds: ['revisions'],
                    fix: `listRevisions ${target.id}`
                });
            if (draft.unit_ref !== target.id || draft.unit_kind !== unitKind) {
                throw new ToolRefusal(
                    'T-11',
                    `revision ${id} belongs to ${draft.unit_ref}, not to ${target.id}, so it cannot be merged with it`,
                    {
                        id,
                        unit_ref: target.id,
                        fix: `listRevisions ${target.id}`
                    }
                );
            }
        }

        const why = whyOf(ctx);
        const parts = String(ctx.args.parts ?? '');
        const { task, reused } = openTask(
            store,
            storyId,
            {
                kind: 'merge',
                title: `Merge ${requested.length} drafts for ${target.id}`,
                detail: `${parts}\nDrafts: ${requested.join(', ')}\nWhy: ${why}`,
                owner_role: 'writer'
            },
            buildAttribution(ctx, why)
        );

        return ok(
            {
                task_id: task.id,
                unit_ref: target.id,
                drafts: requested,
                reused,
                still_competing: pendingRevisions(store, storyId, unitKind, target.id).length,
                next: reused
                    ? `task ${task.id} is already open, so the Writer will merge once (T-24)`
                    : 'the Writer merges and files a new draft; a fresh Work Item selects between the drafts (D-23)'
            },
            task.rev,
            `Merge requested for ${target.id}`,
            { task_id: task.id }
        );
    }
};

/**
 * §8.2 `rejectAll`: nothing written is worth merging, so every draft is marked discarded (the
 * rows survive for the Author's audit and the restore path, D-24) and the brief or the contract
 * is sent back for a re-brief (L-18).
 */
const rejectAll: ToolDefinition = {
    name: 'rejectAll',
    description:
        'Reject every draft for a unit: mark them discarded for audit and open a re-brief task. Use when the problem is the brief or the contract, not the prose.',
    inputSchema: {
        type: 'object',
        properties: {
            unit_ref: str('The unit whose drafts are all rejected (summary | plotline | chapter).'),
            why: whyArg('Why none of the drafts can be merged.'),
            re_brief: str('What the next attempt should do instead — the note the re-brief task carries.'),
            expects: EXPECTS_ARG
        },
        required: ['unit_ref', 'why', 're_brief']
    },
    writes: 'tasks',
    level: 'write',
    primaryArg: 'unit_ref',
    mutating: true,
    requires: ['unit_ref', 'why', 're_brief'],
    async execute(ctx, expects): Promise<ToolResult> {
        const { store, storyId } = ctx;
        const { target, unitKind } = await resolveUnit(ctx, ctx.args.unit_ref);
        const drafts = pendingRevisions(store, storyId, unitKind, target.id);
        if (drafts.length === 0) {
            throw new ToolRefusal('T-11', `nothing is competing for ${target.id}, so there is nothing to reject`, {
                unit_ref: target.id,
                fix: `listRevisions ${target.id}, or ask a Writer for a draft`
            });
        }

        const why = whyOf(ctx);
        const reBrief = typeof ctx.args.re_brief === 'string' ? ctx.args.re_brief.trim() : '';
        let discarded = 0;
        await commitAs(
            ctx,
            'rejectAll',
            async () => {
                // L-18: the drafts are refused, not destroyed — the Author can still read what was
                // turned down, and D-24's restore path needs the rows.
                for (const draft of drafts) {
                    store.revisions.update(
                        draft.id,
                        { state: 'discarded' },
                        buildAttribution(ctx, why),
                        expects.filter((entry) => entry.id === draft.id)
                    );
                    discarded += 1;
                }
                openTask(
                    store,
                    storyId,
                    {
                        kind: 're_brief',
                        title: `Re-brief ${target.id}: all ${drafts.length} drafts rejected`,
                        detail: `${why}${reBrief ? `\nRe-brief: ${reBrief}` : ''}`,
                        owner_role: 'writer'
                    },
                    buildAttribution(ctx, why)
                );
            },
            expects.filter((entry) => entry.id !== target.id)
        );

        return ok(
            {
                unit_ref: target.id,
                discarded: drafts.map((draft) => draft.id),
                count: discarded,
                next: `a Writer works the re-brief task for ${target.id}; the rejected drafts stay readable`
            },
            undefined,
            `Rejected all ${discarded} drafts for ${target.id}`
        );
    }
};

/**
 * §8.2 `compareRevisions`: the differences on ONE axis, as a report rather than a judgment —
 * the judgment is the Editor's own act, and putting it in the tool would hide it from the
 * `selection_note` (T-2a).
 */
const compareRevisions: ToolDefinition = {
    name: 'compareRevisions',
    description:
        'Show named drafts side by side on one axis — pacing, fidelity to must_happen, voice — with the verdicts that scored each. It reports; the Editor decides.',
    inputSchema: {
        type: 'object',
        properties: {
            revision_ids: arr('The drafts to compare.', str('One draft id.')),
            dimension: enumDimension()
        },
        required: ['revision_ids', 'dimension']
    },
    writes: 'revisions',
    level: 'read',
    primaryArg: 'dimension',
    mutating: false,
    requires: ['revision_ids', 'dimension'],
    async execute(ctx): Promise<ToolResult> {
        const { store, storyId } = ctx;
        const requested = (Array.isArray(ctx.args.revision_ids) ? ctx.args.revision_ids : []).map(String);
        if (requested.length < 2)
            throw new ToolRefusal('T-11', 'compareRevisions needs at least two revision_ids', {
                revision_ids: requested,
                fix: 'pass two ids from listRevisions'
            });

        const drafts: Revision[] = [];
        for (const id of requested) {
            const draft = store.revisions.get(id);
            if (!draft || draft.story_id !== storyId)
                throw new ToolRefusal('T-3', `no draft "${id}" in this Story`, {
                    id,
                    expected_kinds: ['revisions'],
                    fix: 'listRevisions for the unit'
                });
            drafts.push(draft as Revision);
        }
        const first = drafts[0];
        const mismatch = drafts.find(
            (draft) => draft.unit_ref !== first.unit_ref || draft.unit_kind !== first.unit_kind
        );
        if (mismatch) {
            throw new ToolRefusal(
                'T-11',
                `revisions ${first.id} and ${mismatch.id} belong to different units, so comparing them measures nothing`,
                {
                    revision_ids: [first.id, mismatch.id],
                    fix: 'compare drafts of one unit'
                }
            );
        }

        const dimension = String(ctx.args.dimension ?? '');
        const verdicts = scopedRows(store.verdicts.list(), storyId) as Verdict[];
        const chapter =
            first.unit_kind === 'chapter' ? (store.chapters.get(first.unit_ref) as Chapter | undefined) : undefined;
        const contract = chapter?.plotline_ref
            ? (store.plotlines.get(chapter.plotline_ref) as Plotline | undefined)
            : undefined;

        return okValue({
            dimension,
            unit_ref: first.unit_ref,
            unit_kind: first.unit_kind,
            // The axis the drafts are being read against, stated so the comparison is auditable.
            against: contract
                ? { must_happen: contract.must_happen ?? '', must_change: contract.must_change ?? '' }
                : null,
            drafts: drafts.map((draft) => {
                const sections = revisionBodySections(draft);
                const text =
                    sections.map((section) => section.text).join('\n\n') ||
                    summarize(JSON.stringify(revisionBodyFields(draft)));
                return {
                    id: draft.id,
                    words: wordCount(text),
                    sections: sections.length,
                    // D-21: the scores travel with the draft, because that is what the Editor is
                    // comparing on; the prose itself is clipped so the read stays bounded (T-7).
                    text: clip(text, 4000),
                    verdicts: verdicts
                        .filter(
                            (verdict) =>
                                draft.verdict_refs.includes(verdict.id) || verdict.target_ref === draft.unit_ref
                        )
                        .map((verdict) => ({
                            id: verdict.id,
                            hard_pass: verdict.hard_pass,
                            soft_count: verdict.soft_count,
                            recommendation: verdict.recommendation,
                            failing: verdict.criteria_passed
                                .filter((criterion) => !criterion.result)
                                .map((criterion) => criterion.criterion)
                        }))
                };
            })
        });
    }
};

/** The comparison axes, as data so `describeTool` can enumerate them (T-6c). */
function enumDimension() {
    return {
        type: 'string',
        enum: ['pacing', 'must_happen', 'voice', 'causality', 'stakes'],
        description: 'The single axis to compare the drafts on.'
    } as Record<string, unknown>;
}

// ── the verification gates ──────────────────────────────────────────────────

/**
 * §8.2 `verifyIdea`: the Editor's independent check of a Reader's claim (D-27/C-15) — re-read
 * the cited source or find a second one, then the verdict, **and** whether the idea fits the
 * Author's guidelines at all (D-31). Until this exists the Author may not select a sourced Idea.
 */
const verifyIdea: ToolDefinition = {
    name: 'verifyIdea',
    description:
        "Record the Editor's independent check of an Idea: the verdict, the evidence, and whether the Idea fits the Author's guidelines. The Author cannot select a sourced Idea that has not been through this.",
    inputSchema: {
        type: 'object',
        properties: {
            idea_id: str('The Idea being verified.'),
            verdict: {
                type: 'string',
                enum: ['verified', 'refuted', 'unverifiable'],
                description: 'What the re-check found (D-27).'
            },
            evidence: str(
                'What was checked and what it showed — a claim the source does not make is `refuted` (C-15).'
            ),
            meets_guidelines: bool("Whether the Idea fits the Author's guidelines and brief at all (D-31)."),
            why: whyArg(),
            expects: EXPECTS_ARG
        },
        required: ['idea_id', 'verdict', 'evidence', 'meets_guidelines', 'why']
    },
    writes: 'ideas',
    level: 'verify',
    primaryArg: 'idea_id',
    mutating: true,
    requires: ['idea_id', 'verdict', 'evidence', 'meets_guidelines', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const target = await mustResolveRef(ctx, ctx.args.idea_id, 'idea_id', ['ideas']);
        const idea = resolvedIdea(target);
        const verdict = String(ctx.args.verdict ?? '') as Idea['verification'] extends infer _
            ? 'verified' | 'refuted' | 'unverifiable'
            : never;
        const evidence = String(ctx.args.evidence ?? '').trim();
        if (!evidence) {
            throw new ToolRefusal(
                'T-11',
                'verifyIdea needs `evidence`: the verdict has to say what was checked (C-15)',
                { field: 'evidence', idea_id: idea.id, fix: 'name the source and what it actually says' }
            );
        }

        const why = whyOf(ctx);
        // D-27/C-15: an Idea that cites a source for a claim the source does not make is REFUTED,
        // not "mostly right", so a refuted verdict needs the sources present to be checkable.
        if (verdict === 'refuted' && idea.sources.length === 0) {
            throw new ToolRefusal(
                'C-15',
                `Idea ${idea.id} cites no source, so there is no claim to refute — an unsourced Idea is judged on guidelines, not refuted`,
                {
                    idea_id: idea.id,
                    fix: 'use verdict "unverifiable", or judge it against the guidelines (D-31)'
                }
            );
        }

        const state = verdict === 'verified' ? 'verified' : verdict === 'refuted' ? 'refuted' : 'unverifiable';
        const written = (await commitAs(
            ctx,
            'verifyIdea',
            () =>
                ctx.store.ideas.update(
                    idea.id,
                    {
                        state,
                        verification: {
                            verdict,
                            evidence,
                            meets_guidelines: ctx.args.meets_guidelines === true,
                            checked_by_run: ctx.runId ?? '',
                            checked_at: nowIso()
                        }
                    },
                    buildAttribution(ctx, why),
                    expects
                ),
            expects
        )) as Idea;

        return ok(
            {
                id: written.id,
                state: written.state,
                meets_guidelines: written.verification?.meets_guidelines ?? false,
                sources: written.sources.length,
                current_rev: written.rev,
                next: written.verification?.meets_guidelines
                    ? 'the Author can now select it (C-15 is satisfied for this Idea)'
                    : "the Editor judges it outside the Author's guidelines (D-31); the Author still decides"
            },
            written.rev,
            `Idea ${written.id} ${written.state}`
        );
    }
};

/**
 * §8.2 `verifyFinding`: confirm or dispute a suspicion (D-33) and rewrite it into the Author's
 * reading surface (D-34) — one clear claim, the evidence line, and the cost it actually deserves.
 * Only a confirmed finding can be approved, spawn a task, invalidate a chapter, or count toward
 * `pending`.
 */
const verifyFinding: ToolDefinition = {
    name: 'verifyFinding',
    description:
        'Confirm or dispute a finding, and rewrite it into the wording the Author reads: one clear claim, the evidence, and the cost it deserves. A disputed finding costs no Writer pass.',
    inputSchema: {
        type: 'object',
        properties: {
            finding_id: str('The finding to verify.'),
            verdict: {
                type: 'string',
                enum: ['confirmed', 'disputed'],
                description: 'Whether the suspicion holds up (D-33).'
            },
            cost: COST_ENUM,
            title: str('Optional rewrite: the finding as one clear claim (D-34).'),
            detail: str('Optional rewrite: the supporting detail.'),
            evidence: str('What the check consisted of and what it showed.'),
            why: whyArg(),
            expects: EXPECTS_ARG
        },
        required: ['finding_id', 'verdict', 'cost', 'evidence', 'why']
    },
    writes: 'findings',
    level: 'verify',
    primaryArg: 'finding_id',
    mutating: true,
    requires: ['finding_id', 'verdict', 'cost', 'evidence', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const target = await mustResolveRef(ctx, ctx.args.finding_id, 'finding_id', ['findings']);
        const finding = target.record as Finding;
        if (finding.state === 'fixed' || finding.state === 'discarded') {
            throw new ToolRefusal(
                'D-33',
                `finding ${finding.id} is ${finding.state}, so re-verifying it would rewrite settled history`,
                {
                    finding_id: finding.id,
                    state: finding.state,
                    fix: 'raise a new finding if the problem came back'
                }
            );
        }

        const verdict = String(ctx.args.verdict ?? '');
        const cost = String(ctx.args.cost ?? '');
        const why = whyOf(ctx);
        // D-34: the ORIGINAL wording is what the Author must be able to compare against, and the
        // §4.10 record has no `raised_*` fields — so it is reported here, and the store's commit
        // journal keeps it as the patch this write replaced.
        const original = {
            title: finding.title,
            detail: finding.detail ?? '',
            cost: finding.cost,
            evidence: finding.evidence
        };

        const patch: Record<string, unknown> = {
            state: verdict === 'confirmed' ? 'confirmed' : 'disputed',
            cost,
            evidence: `${finding.evidence}\n\nEditor check: ${String(ctx.args.evidence ?? '').trim()}`,
            confirmed_by: ctx.actorLabel
        };
        if (typeof ctx.args.title === 'string' && ctx.args.title.trim()) patch.title = ctx.args.title.trim();
        if (typeof ctx.args.detail === 'string' && ctx.args.detail.trim()) patch.detail = ctx.args.detail.trim();

        const written = (await commitAs(
            ctx,
            'verifyFinding',
            () => ctx.store.findings.update(finding.id, patch, buildAttribution(ctx, why), expects),
            expects
        )) as Finding;

        return ok(
            {
                id: written.id,
                state: written.state,
                cost: written.cost,
                title: written.title,
                original,
                current_rev: written.rev,
                next:
                    written.state === 'confirmed'
                        ? `approveFinding ${written.id} to hand the repair to a Writer, or let the Story's switch decide (D-35)`
                        : 'a disputed finding spawns no task and does not count toward pending (D-33)'
            },
            written.rev,
            `Finding ${written.id} ${written.state} as ${written.cost}`
        );
    }
};

/**
 * §8.2 `approveFinding`: the gate (D-34). Approve spawns the Writer's task; discard closes the
 * finding with the reason kept for audit; `auto` makes the same call when the Story's switch
 * covers that cost (D-35) and refuses when it does not, so the dial is the only authority.
 */
const approveFinding: ToolDefinition = {
    name: 'approveFinding',
    description:
        "Decide a confirmed finding: approve it into a Writer task, discard it with the reason kept, or let the Story's auto-approve switch decide. An unconfirmed finding cannot be approved (D-33).",
    inputSchema: {
        type: 'object',
        properties: {
            finding_id: str('The finding to decide.'),
            decision: {
                type: 'string',
                enum: ['approve', 'discard', 'auto'],
                description: '"auto" follows stories.auto_approve for this cost (D-35).'
            },
            why: whyArg(),
            expects: EXPECTS_ARG
        },
        required: ['finding_id', 'decision', 'why']
    },
    writes: 'findings',
    level: 'write_verify',
    primaryArg: 'finding_id',
    mutating: true,
    requires: ['finding_id', 'decision', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const { store, storyId } = ctx;
        const target = await mustResolveRef(ctx, ctx.args.finding_id, 'finding_id', ['findings']);
        const finding = target.record as Finding;
        const decision = String(ctx.args.decision ?? '');
        const why = whyOf(ctx);

        // D-35: the switch decides `auto`, so a call the switch does not cover is refused rather
        // than quietly escalated — that is what makes the dial meaningful (D-35b).
        let approvedBy = ctx.actorLabel;
        if (decision === 'auto') {
            if (!ctx.story.auto_approve.includes(finding.cost)) {
                throw new ToolRefusal(
                    'D-35',
                    `this Story's auto_approve covers ${ctx.story.auto_approve.length ? ctx.story.auto_approve.join(', ') : 'nothing'}, which does not include a ${finding.cost} finding, so it needs the Author`,
                    {
                        finding_id: finding.id,
                        cost: finding.cost,
                        auto_approve: ctx.story.auto_approve,
                        fix: 'the Author decides it, or widens the switch (D-35b: the same switch moves the drain threshold)'
                    }
                );
            }
            approvedBy = 'auto';
        }

        // D-33: only a confirmed finding can be approved, spawn a task, invalidate a chapter or
        // count toward pending.
        if (decision !== 'discard' && finding.state !== 'confirmed') {
            throw new ToolRefusal(
                'D-33',
                `finding ${finding.id} is ${finding.state}, and only a confirmed finding can be approved`,
                {
                    finding_id: finding.id,
                    state: finding.state,
                    fix: 'run verifyFinding first — approval must never act on an unverified suspicion'
                }
            );
        }

        const written = (await commitAs(
            ctx,
            'approveFinding',
            async () => {
                const updated = store.findings.update(
                    finding.id,
                    {
                        state: decision === 'discard' ? 'discarded' : 'approved',
                        approved_by: decision === 'discard' ? null : approvedBy
                    },
                    buildAttribution(ctx, why),
                    expects
                );
                if (decision !== 'discard') {
                    // D-34: approval is what creates the work item, so an unapproved finding can
                    // never reach a Writer's task list.
                    openTask(
                        store,
                        storyId,
                        {
                            kind: 'fix',
                            title: `${finding.title}`,
                            detail: `${finding.detail ?? ''}\nCost: ${finding.cost}\nCriterion: ${finding.criterion_ref}\nFinding: ${finding.id}\nApproved by: ${approvedBy}`,
                            owner_role: 'writer',
                            criterion_ref: finding.criterion_ref,
                            finding_ref: finding.id
                        },
                        buildAttribution(ctx, why)
                    );
                }
                return updated;
            },
            expects
        )) as Finding;

        return ok(
            {
                id: written.id,
                state: written.state,
                approved_by: written.approved_by ?? null,
                decision,
                current_rev: written.rev,
                next:
                    decision === 'discard'
                        ? 'the reason is kept in the audit trail, and nothing was handed to a Writer (D-34)'
                        : `a Writer task is open for ${written.target_ref} (D-34)`
            },
            written.rev,
            `Finding ${written.id} ${written.state}`
        );
    }
};

/** §8.2 `listIdeas`: what the Readers put forward, with their verification state. */
const listIdeas: ToolDefinition = {
    name: 'listIdeas',
    description:
        'List the Ideas in the tray — including the ones already selected, discarded or deferred, which every brief must carry so the next run does not re-propose them (D-32).',
    inputSchema: {
        type: 'object',
        properties: {
            phase: PHASE_ENUM,
            state: IDEA_STATE_ENUM,
            unit_ref: str('Optional filter: only Ideas attached to this record.'),
            limit: num('Maximum items to return (default 50).'),
            offset: num('Index of the first item to return (default 0).')
        },
        required: []
    },
    writes: 'ideas',
    level: 'read',
    mutating: false,
    async execute(ctx): Promise<ToolResult> {
        const { store, storyId } = ctx;
        const { limit, offset } = parsePageArgs(ctx.args, PAGE_LIMIT.medium);
        const phase = ctx.args.phase ? String(ctx.args.phase) : '';
        const state = ctx.args.state ? String(ctx.args.state) : '';
        const unitRef = ctx.args.unit_ref ? String(ctx.args.unit_ref) : '';

        let rows = ideaRows(store, storyId);
        if (phase) rows = rows.filter((idea) => idea.phase === phase);
        if (state) rows = rows.filter((idea) => idea.state === state);
        if (unitRef) {
            const target = await mustResolveRef(ctx, unitRef, 'unit_ref', [
                'summaries',
                'plotlines',
                'chapters',
                'cast',
                'ledger'
            ]);
            rows = rows.filter((idea) => idea.unit_ref === target.id);
        }
        const page = rows.slice(offset, offset + limit);
        return okPage(
            page.map((idea) => ({
                id: idea.id,
                body: idea.body,
                kind: idea.kind,
                state: idea.state,
                phase: idea.phase,
                unit_ref: idea.unit_ref ?? null,
                author: idea.author,
                sources: idea.sources.length,
                // D-27: the verification is what makes an Idea selectable, so it is always shown.
                verification: idea.verification ?? null,
                seen_count: idea.seen_count,
                selection_note: idea.selection_note ?? null,
                absorbed_into: idea.absorbed_into ?? null
            })),
            { total: rows.length, limit, offset }
        );
    }
};

/**
 * §8.2 `delegate`: fan out to fresh sub-contexts inside this run to reach a conclusion (D-17e).
 * It writes nothing: the sub-agent's work is reported back, and any write it makes is the
 * parent's permission row talking (T-2b).
 */
const delegate: ToolDefinition = {
    name: 'delegate',
    description:
        'Hand a reasoning task to a fresh sub-context inside this run and report what came back. It stays inside one run and one Story, and cannot write anything the parent could not.',
    inputSchema: {
        type: 'object',
        properties: {
            role: str('The role name or kind to delegate to (a template role name, or writer/editor/checker/reader).'),
            task: str('What to work out, stated so one answer closes it.')
        },
        required: ['role', 'task']
    },
    // §7 has no row for delegation as a story write: it is in-run reasoning the run layer answers,
    // which is why every kind may recommend it and no kind is refused by the table.
    writes: 'runs',
    level: 'recommend',
    primaryArg: 'role',
    mutating: false,
    requires: ['role', 'task'],
    async execute(ctx): Promise<ToolResult> {
        const role = String(ctx.args.role ?? '');
        const task = String(ctx.args.task ?? '');
        if (!ctx.delegate) {
            throw new ToolRefusal('D-17e', `this run was not given a delegation hook, so "${role}" cannot be asked`, {
                role,
                fix: 'ask the template to declare the delegation (D-17e), or work the task in this run'
            });
        }
        const result = await ctx.delegate(role, task);
        return okValue({
            role,
            task: summarize(task),
            result: result ?? null,
            next: "fold the answer into this run's own report; the sub-context filed nothing of its own (T-2b)"
        });
    }
};

/** §8.2 — the Editor surface, in spec order. */
export const editorTools: ToolDefinition[] = [
    listRevisions,
    selectRevision,
    requestMerge,
    rejectAll,
    compareRevisions,
    verifyIdea,
    verifyFinding,
    approveFinding,
    listIdeas,
    delegate
];
