/**
 * W2 acceptance for the §8 catalogue (T-6, T-6a, T-6c, T-13, and the W2 row of §12).
 *
 * §12 W2 demands three things of this file's subject: every session sees every tool, the server
 * refuses what the role may not do, and **`describeTool` returns the exact shape of every tool in
 * §8**. The §8 tables are therefore transcribed here as data — args, required args, the §7 row
 * each tool keys on, the level it needs, and who may call it — so a drift between the spec and the
 * registry is a failing test rather than a smaller catalogue in production (T-13: "capabilities
 * are registered tools, not prompt prose").
 *
 * Every assertion is an exact value.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import type { RoleKind, Story } from '../../shared/types';
import { createToolRuntime, type RunToolContext, type ToolResult } from './index';
import { ALL_TOOLS, GROUP_OF_TOOL, SPEC_TOOL_NAMES, TOOL_BY_NAME, TOOL_GROUPS, TOOL_NAMES } from './registry';
import { mayCallKind } from './permissions';
import type { ToolDefinition } from './types';

/** §8's five groups, counted straight off the spec's tables (§8.1 8, §8.2 10, §8.3 6, §8.4 17, §8.5 4). */
const SPEC_GROUP_SIZES: Record<keyof typeof TOOL_GROUPS, string[]> = {
    // §8.1 — the Writer surface.
    writer: [
        'editSummary',
        'createPlotline',
        'editPlotline',
        'createChapter',
        'editChapter',
        'deleteChapter',
        'updateDigest',
        'proposeChange'
    ],
    // §8.2 — the Editor surface.
    editor: [
        'listRevisions',
        'selectRevision',
        'requestMerge',
        'rejectAll',
        'compareRevisions',
        'verifyIdea',
        'verifyFinding',
        'approveFinding',
        'listIdeas',
        'delegate'
    ],
    // §8.3 — the checker surface.
    checker: ['submitVerdict', 'raiseFinding', 'createTask', 'editTask', 'requestAuthor', 'markChapterDone'],
    // §8.4 — shared plumbing, in §8's row order (`readX / editX` rows expand into two names).
    plumbing: [
        'readSeed',
        'readSummary',
        'readIdeas',
        'readPlotline',
        'readChapter',
        'readCast',
        'editCast',
        'readLedger',
        'editLedger',
        'readDigest',
        'readGoals',
        'listTasks',
        'readVerdicts',
        'readFindings',
        'listTools',
        'describeTool',
        'reportGap'
    ],
    // §8.5 — research and proposal.
    research: ['searchWeb', 'fetchPage', 'proposeIdea', 'markUnverifiable']
};

/**
 * The whole §8 surface as one table: the args §8 lists, the subset §8 marks required (an arg with
 * no `?` in the table), the §7 collection/level the call needs, and which kinds may call it.
 *
 * `allow` is four characters in the order **writer, editor, checker, reader** — `y` for "the §7
 * row (or §8's explicit grant) accepts the call". The two places the row alone is not the whole
 * answer are visible here: `updateDigest` is `nnnn` because the Digest is engine-derived (D-12a),
 * and `selectRevision` is `nynn` because §7 gives the Writer `write` on `revisions` for CREATING
 * them through `editChapter`, while choosing between them is the Editor's job (T-3b).
 */
const SPEC_TOOL_CONTRACT: Record<
    string,
    { args: string[]; required: string[]; writes: string; level: string; allow: string }
> = {
    editSummary: {
        args: ['premise', 'promise', 'theme', 'tone', 'ending', 'world_rules', 'expects', 'why'],
        required: ['why'],
        writes: 'summaries',
        level: 'write',
        allow: 'ynnn'
    },
    createPlotline: {
        args: ['heading', 'order', 'must_happen', 'must_change', 'pov', 'setups', 'payoffs', 'expects', 'why'],
        required: ['heading', 'order', 'must_happen', 'must_change', 'why'],
        writes: 'plotlines',
        level: 'write',
        allow: 'ynnn'
    },
    editPlotline: {
        args: [
            'plotline_id',
            'heading',
            'order',
            'must_happen',
            'must_change',
            'pov',
            'setups',
            'payoffs',
            'expects',
            'why'
        ],
        required: ['plotline_id', 'why'],
        writes: 'plotlines',
        level: 'write',
        allow: 'ynnn'
    },
    createChapter: {
        args: ['plotline_id', 'title', 'summary', 'order', 'expects', 'why'],
        required: ['plotline_id', 'title', 'summary', 'why'],
        writes: 'chapters',
        level: 'write',
        allow: 'ynnn'
    },
    // §8.1's note makes `rewrite` part of the tool: "a whole-chapter `rewrite` is a separate
    // explicit flag (D-7)".
    editChapter: {
        args: ['chapter_id', 'section_id', 'content', 'rewrite', 'title', 'summary', 'expects', 'why'],
        required: ['chapter_id', 'why'],
        writes: 'chapters',
        level: 'write',
        allow: 'ynnn'
    },
    deleteChapter: {
        args: ['chapter_id', 'expects', 'why'],
        required: ['chapter_id', 'why'],
        writes: 'chapters',
        level: 'write',
        allow: 'ynnn'
    },
    updateDigest: {
        args: ['body', 'expects', 'why'],
        required: ['body', 'why'],
        writes: 'digests',
        level: 'write',
        allow: 'nnnn'
    },
    proposeChange: {
        args: ['target_ref', 'target_field', 'patch', 'why'],
        required: ['target_ref', 'target_field', 'why'],
        writes: 'proposals',
        level: 'write',
        allow: 'yyyy'
    },
    listRevisions: { args: ['unit_ref'], required: ['unit_ref'], writes: 'revisions', level: 'read', allow: 'yyyy' },
    selectRevision: {
        args: ['unit_ref', 'revision_id', 'selection_note', 'expects'],
        required: ['unit_ref', 'revision_id', 'selection_note'],
        writes: 'revisions',
        level: 'write',
        allow: 'nynn'
    },
    requestMerge: {
        args: ['unit_ref', 'revision_ids', 'parts', 'why'],
        required: ['unit_ref', 'revision_ids', 'parts', 'why'],
        writes: 'tasks',
        level: 'write',
        allow: 'yyyy'
    },
    rejectAll: {
        args: ['unit_ref', 'why', 're_brief', 'expects'],
        required: ['unit_ref', 'why', 're_brief'],
        writes: 'tasks',
        level: 'write',
        allow: 'yyyy'
    },
    compareRevisions: {
        args: ['revision_ids', 'dimension'],
        required: ['revision_ids', 'dimension'],
        writes: 'revisions',
        level: 'read',
        allow: 'yyyy'
    },
    verifyIdea: {
        args: ['idea_id', 'verdict', 'evidence', 'meets_guidelines', 'why', 'expects'],
        required: ['idea_id', 'verdict', 'evidence', 'meets_guidelines', 'why'],
        writes: 'ideas',
        level: 'verify',
        allow: 'nynn'
    },
    verifyFinding: {
        args: ['finding_id', 'verdict', 'cost', 'title', 'detail', 'evidence', 'why', 'expects'],
        required: ['finding_id', 'verdict', 'cost', 'evidence', 'why'],
        writes: 'findings',
        level: 'verify',
        allow: 'nynn'
    },
    approveFinding: {
        args: ['finding_id', 'decision', 'why', 'expects'],
        required: ['finding_id', 'decision', 'why'],
        writes: 'findings',
        level: 'write_verify',
        allow: 'nynn'
    },
    listIdeas: {
        args: ['phase', 'state', 'unit_ref', 'limit', 'offset'],
        required: [],
        writes: 'ideas',
        level: 'read',
        allow: 'yyyy'
    },
    delegate: { args: ['role', 'task'], required: ['role', 'task'], writes: 'runs', level: 'recommend', allow: 'yyyy' },
    submitVerdict: {
        args: ['target_ref', 'criteria_passed', 'recommendation', 'why'],
        required: ['target_ref', 'criteria_passed', 'recommendation'],
        writes: 'verdicts',
        level: 'write',
        allow: 'yyyy'
    },
    raiseFinding: {
        // §8.3's row plus the one additive arg W2 carries for L-11a (`related_refs`), which is
        // optional so every §8-shaped call still validates exactly as §8 describes it.
        args: ['target_ref', 'criterion_ref', 'title', 'detail', 'evidence', 'cost', 'related_refs', 'why'],
        required: ['target_ref', 'criterion_ref', 'title', 'evidence', 'cost'],
        writes: 'findings',
        level: 'write',
        allow: 'yyyy'
    },
    createTask: {
        args: ['title', 'detail', 'owner_role', 'criterion_ref', 'finding_ref', 'priority', 'done', 'why'],
        required: ['title', 'detail', 'owner_role', 'priority', 'why'],
        writes: 'tasks',
        level: 'write',
        allow: 'yyyy'
    },
    editTask: {
        args: ['task_id', 'state', 'detail', 'owner_role', 'priority', 'expects', 'why'],
        required: ['task_id', 'why'],
        writes: 'tasks',
        level: 'write',
        allow: 'yyyy'
    },
    requestAuthor: {
        args: ['question', 'options', 'context', 'priority', 'why'],
        required: ['question', 'options', 'why'],
        writes: 'tasks',
        level: 'write',
        allow: 'yyyy'
    },
    markChapterDone: {
        args: ['chapter_id', 'evidence', 'why'],
        required: ['chapter_id'],
        writes: 'tasks',
        level: 'write',
        allow: 'yyyy'
    },
    readSeed: { args: [], required: [], writes: 'stories', level: 'read', allow: 'yyyy' },
    readSummary: { args: [], required: [], writes: 'summaries', level: 'read', allow: 'yyyy' },
    readIdeas: {
        args: ['phase', 'state', 'unit_ref', 'limit', 'offset'],
        required: [],
        writes: 'ideas',
        level: 'read',
        allow: 'yyyy'
    },
    readPlotline: {
        args: ['plotline_id', 'order', 'list'],
        required: [],
        writes: 'plotlines',
        level: 'read',
        allow: 'yyyy'
    },
    readChapter: {
        args: ['chapter_id', 'sections'],
        required: ['chapter_id'],
        writes: 'chapters',
        level: 'read',
        allow: 'yyyy'
    },
    readCast: { args: ['limit', 'offset'], required: [], writes: 'cast', level: 'read', allow: 'yyyy' },
    editCast: {
        args: ['cast_id', 'name', 'want', 'need', 'arc', 'voice', 'state_now', 'traits', 'gender', 'expects', 'why'],
        required: ['why'],
        writes: 'cast',
        level: 'write',
        allow: 'ynnn'
    },
    readLedger: {
        args: ['kind', 'status', 'limit', 'offset'],
        required: [],
        writes: 'ledger',
        level: 'read',
        allow: 'yyyy'
    },
    editLedger: {
        args: ['ledger_id', 'kind', 'subject', 'detail', 'chapter_ref', 'status', 'expects', 'why'],
        required: ['why'],
        writes: 'ledger',
        level: 'write',
        allow: 'ynnn'
    },
    readDigest: { args: [], required: [], writes: 'digests', level: 'read', allow: 'yyyy' },
    readGoals: { args: [], required: [], writes: 'goals', level: 'read', allow: 'yyyy' },
    listTasks: {
        args: ['state', 'owner_role', 'limit', 'offset'],
        required: [],
        writes: 'tasks',
        level: 'read',
        allow: 'yyyy'
    },
    readVerdicts: {
        args: ['target_ref', 'recommendation', 'limit', 'offset'],
        required: [],
        writes: 'verdicts',
        level: 'read',
        allow: 'yyyy'
    },
    readFindings: {
        args: ['target_ref', 'state', 'cost', 'limit', 'offset'],
        required: [],
        writes: 'findings',
        level: 'read',
        allow: 'yyyy'
    },
    listTools: { args: ['kind', 'writes'], required: [], writes: 'templates', level: 'read', allow: 'yyyy' },
    describeTool: { args: ['name'], required: ['name'], writes: 'templates', level: 'read', allow: 'yyyy' },
    reportGap: {
        args: ['job', 'needed', 'tried', 'tool', 'why'],
        required: ['job', 'needed', 'tried', 'why'],
        writes: 'tasks',
        level: 'write',
        allow: 'yyyy'
    },
    searchWeb: { args: ['query', 'maxResults'], required: ['query'], writes: 'runs', level: 'read', allow: 'yyyy' },
    fetchPage: { args: ['url', 'query'], required: ['url'], writes: 'runs', level: 'read', allow: 'yyyy' },
    proposeIdea: {
        args: ['phase', 'unit_ref', 'body', 'kind', 'sources', 'why'],
        required: ['phase', 'body', 'kind', 'sources', 'why'],
        writes: 'ideas',
        level: 'write',
        allow: 'nnyy'
    },
    markUnverifiable: {
        args: ['idea_id', 'checked', 'why'],
        required: ['idea_id', 'why'],
        writes: 'ideas',
        level: 'write',
        allow: 'nnyy'
    }
};

/** The kinds in `allow`'s order, so the table above has one reading. */
const ALLOW_ORDER: RoleKind[] = ['writer', 'editor', 'checker', 'reader'];

/** `describeTool`'s answer keys, in the order the tool builds them (T-6c: "the exact shape"). */
const DESCRIBE_KEYS = [
    'name',
    'description',
    'required',
    'fields',
    'enums',
    'expects',
    'why',
    'permission',
    'permission_rows',
    'may_call_as_this_role',
    'rule_ids'
];

/** The T-6c note every `listTools` answer carries. */
const LIST_NOTE =
    'Every session holds the whole catalogue; the server refuses what your role may not do, naming the rule (T-1a, T-6a).';

/** Builds one bound session (T-3 binds the Story, T-0 binds the kind). */
function sessionFor(storyId: string, roleKind: RoleKind) {
    return { storyId, roleKind, roleName: `${roleKind}_1`, runId: `run_${roleKind}` };
}

/** The §12 W2 sentence's shape: one Story, one runtime, four kinds of session. */
async function callAs(
    store: Store,
    roleKind: RoleKind,
    name: string,
    args: Record<string, unknown>
): Promise<ToolResult> {
    const runtime = createToolRuntime(store);
    const context: RunToolContext = runtime.createContext(sessionFor('story_1', roleKind));
    return runtime.execute(context, name, args);
}

describe('the §8 catalogue', () => {
    let store: Store;
    let story: Story;

    beforeEach(() => {
        store = Store.empty();
        story = store.stories.create(
            {
                title: 'The Light Keeper',
                phase: 'chapters',
                idea: 'A keeper, a light, a debt.',
                summary_locked: false,
                plotlines_locked: false,
                pending_kind: 'none',
                status: 'ready',
                trend: 'unknown',
                auto_approve: ['critical'],
                author_stop: false,
                digest_rev: 0,
                template_refs: [],
                chapter_deps: {}
            },
            { why: 'seed: story created' }
        );
    });

    it('registers §8.1–§8.5 exactly, in §8 order, with no duplicates (T-6a, T-13)', () => {
        // The groups are kept separate so this fails against the SPECIFIC section that drifted.
        for (const group of Object.keys(SPEC_GROUP_SIZES) as (keyof typeof TOOL_GROUPS)[])
            expect({ group, tools: TOOL_GROUPS[group].map((tool) => tool.name) }).toEqual({
                group,
                tools: SPEC_GROUP_SIZES[group]
            });

        // T-6a: registration is the flat union of the five sections — 45 tools, no shadowing.
        expect(TOOL_NAMES).toEqual([...SPEC_TOOL_NAMES]);
        expect(TOOL_NAMES.length).toBe(45);
        expect(ALL_TOOLS.length).toBe(45);
        expect(TOOL_BY_NAME.size).toBe(45);
        // Every tool knows its own section, which is what `describeTool`'s provenance reads.
        expect(TOOL_NAMES.map((name) => GROUP_OF_TOOL.get(name) ?? 'missing')).toEqual([
            ...SPEC_GROUP_SIZES.writer.map(() => 'writer'),
            ...SPEC_GROUP_SIZES.editor.map(() => 'editor'),
            ...SPEC_GROUP_SIZES.checker.map(() => 'checker'),
            ...SPEC_GROUP_SIZES.plumbing.map(() => 'plumbing'),
            ...SPEC_GROUP_SIZES.research.map(() => 'research')
        ]);
        // And the contract table below cannot silently fall behind the registry.
        expect(Object.keys(SPEC_TOOL_CONTRACT)).toEqual([...TOOL_NAMES]);
    });

    it('gives every session the whole catalogue whatever the kind (T-6a)', async () => {
        const runtime = createToolRuntime(store);
        // The harness registers the same schema list on every session, whatever `kind` says.
        expect(runtime.schemas().map((schema) => schema.function.name)).toEqual([...TOOL_NAMES]);
        // And the run's own `listTools` answer — with no `kind` filter — says the same thing, so
        // "can this role reach that tool?" is answerable from inside the run (T-6c).
        for (const roleKind of ALLOW_ORDER) {
            const context = runtime.createContext(sessionFor(story.id, roleKind));
            const data = (await runtime.execute(context, 'listTools', {})).data as Record<string, any>;
            expect({
                roleKind,
                role: data.role,
                total: data.total,
                tools: data.tools.map((row: { name: string }) => row.name)
            }).toEqual({ roleKind, role: roleKind, total: 45, tools: [...TOOL_NAMES] });
        }
    });

    it('registers each tool as an OpenAI function schema a fresh session sees on turn one (T-6, T-13)', () => {
        const runtime = createToolRuntime(store);
        const schemas = runtime.schemas();
        expect(schemas.map((schema) => schema.function.name)).toEqual([...TOOL_NAMES]);
        for (const def of ALL_TOOLS) {
            const schema = schemas.find((candidate) => candidate.function.name === def.name)!;
            // T-6's host-side shape, and T-6c's "one-line purpose" is the SAME string `listTools`
            // prints, so the two discovery surfaces cannot disagree.
            expect(schema).toEqual({
                type: 'function',
                function: { name: def.name, description: def.description, parameters: def.inputSchema }
            });
            const properties = def.inputSchema.properties as Record<string, { description?: string }>;
            expect(def.inputSchema.type).toBe('object');
            // T-13: the schema says what each field is for — no "the agent should know how".
            expect(Object.values(properties).map((property) => Boolean(property.description))).toEqual(
                Object.keys(properties).map(() => true)
            );
            // T-3: the Story is bound, so no tool may accept one as an argument.
            expect(Object.keys(properties)).not.toContain('story_id');
        }

        // A caller mutating the returned list cannot shrink the catalogue for the next session.
        schemas.length = 1;
        schemas[0] = { type: 'function', function: { name: 'x', description: '', parameters: {} } };
        expect(runtime.schemas().map((schema) => schema.function.name)).toEqual([...TOOL_NAMES]);
    });

    it("is §8's arg table, tool for tool, read back through describeTool (W2, T-13)", async () => {
        for (const [name, contract] of Object.entries(SPEC_TOOL_CONTRACT)) {
            const result = await callAs(store, 'writer', 'describeTool', { name });
            expect(result.ok).toBe(true);
            const info = result.data as Record<string, any>;
            expect(Object.keys(info)).toEqual(DESCRIBE_KEYS);
            expect({ name, fields: info.fields.map((field: { name: string }) => field.name) }).toEqual({
                name,
                fields: contract.args
            });
            expect({ name, required: info.required }).toEqual({ name, required: contract.required });
            // §7's row, as the tool reads it (P10 is enforced from this, not from a prompt).
            expect({ name, permission: info.permission }).toEqual({
                name,
                permission: { writes: contract.writes, level: contract.level }
            });
            // The kind column, computed the way `listTools` reports it: one predicate, so the
            // answer an agent reads and the answer the call gets cannot drift (T-6c).
            const def: ToolDefinition = TOOL_BY_NAME.get(name)!;
            expect({ name, allow: ALLOW_ORDER.map((role) => (mayCallKind(role, def) ? 'y' : 'n')).join('') }).toEqual({
                name,
                allow: contract.allow
            });
        }
    });

    it('answers listTools with the whole catalogue and who may call what (T-6c, T-6a)', async () => {
        const result = await callAs(store, 'reader', 'listTools', {});
        const data = result.data as Record<string, any>;

        expect(Object.keys(data)).toEqual(['role', 'role_name', 'tools', 'total', 'note']);
        expect({ role: data.role, role_name: data.role_name, total: data.total, note: data.note }).toEqual({
            role: 'reader',
            role_name: 'reader_1',
            total: 45,
            note: LIST_NOTE
        });

        // The row shape is the T-6a answer made visible: the tool is listed whatever the kind, and
        // the four `allowed_for_*` flags say what the server would accept.
        expect(data.tools[0]).toEqual({
            name: 'editSummary',
            purpose: TOOL_BY_NAME.get('editSummary')!.description,
            writes: 'summaries',
            needs: { expects: true, why: true },
            allowed_for_writer: true,
            allowed_for_editor: false,
            allowed_for_checker: false,
            allowed_for_reader: false,
            allowed_for_this_role: false
        });
        // `updateDigest` is the row that proves presence and permission are separate questions
        // (§8.1 keeps it registered and refuses it for everyone, D-12a).
        expect(data.tools[6]).toEqual({
            name: 'updateDigest',
            purpose: TOOL_BY_NAME.get('updateDigest')!.description,
            writes: 'digests',
            needs: { expects: true, why: true },
            allowed_for_writer: false,
            allowed_for_editor: false,
            allowed_for_checker: false,
            allowed_for_reader: false,
            allowed_for_this_role: false
        });

        // `kind` narrows to what that kind could actually call — how a run checks a handoff is
        // possible before it files the task (§7's column sums).
        for (const [kind, total] of [
            ['writer', 38],
            ['editor', 34],
            ['checker', 32],
            ['reader', 32]
        ] as [RoleKind, number][]) {
            const filtered = await callAs(store, kind, 'listTools', { kind });
            const rows = (filtered.data as Record<string, any>).tools as Array<Record<string, unknown>>;
            expect({ kind, total: rows.length }).toEqual({ kind, total });
            expect(rows.every((row) => row[`allowed_for_${kind}`] === true)).toBe(true);
        }

        // A Reader holds `proposeIdea` and not `editChapter` — T-9's one extra right, visible from
        // inside the run rather than only from the harness config.
        const readerRows = (await callAs(store, 'reader', 'listTools', { kind: 'reader' })).data as Record<string, any>;
        const readerNames = readerRows.tools.map((row: { name: string }) => row.name);
        expect(readerNames).toContain('proposeIdea');
        expect(readerNames.filter((name: string) => name === 'editChapter' || name === 'updateDigest')).toEqual([]);
    });

    it('describes one tool exactly, enums and permission row included (T-6c, T-11)', async () => {
        const result = await callAs(store, 'reader', 'describeTool', { name: 'raiseFinding' });

        // W2's sentence "returns the exact shape of every tool in §8" pinned on the tool §8 singles
        // out for a required enum.
        expect(result.data).toEqual({
            name: 'raiseFinding',
            description:
                'File a defect: the artifact, the criterion it fails, a title, the evidence, and a cost. Name related_refs — the other records the same defect touches — and it propagates across chapters instead of being re-raised unit by unit (L-11a). A checker or reader finding starts unconfirmed until an Editor confirms it (D-33); the same claim again bumps seen_count instead of opening a row (D-16).',
            required: ['target_ref', 'criterion_ref', 'title', 'evidence', 'cost'],
            fields: [
                {
                    name: 'target_ref',
                    type: 'string',
                    required: true,
                    description: 'The artifact that fails (a chapter, plotline or summary id).'
                },
                {
                    name: 'criterion_ref',
                    type: 'string',
                    required: true,
                    description: 'The criterion id it fails (readGoals lists them).'
                },
                {
                    name: 'title',
                    type: 'string',
                    required: true,
                    description: 'The defect in one line, specific enough to act on (P4).'
                },
                {
                    name: 'detail',
                    type: 'string',
                    required: false,
                    description: 'What is wrong and where — the lines or rows involved.'
                },
                {
                    name: 'evidence',
                    type: 'string',
                    required: true,
                    description: 'The citable proof (D-15): a quote, a line range, a ledger row.'
                },
                {
                    name: 'cost',
                    type: 'string',
                    enum: ['critical', 'major', 'minor', 'taste'],
                    required: true,
                    description: 'How much the repair costs (D-35b triage scale).'
                },
                {
                    // L-11a: the additive arg, spelled out so a fresh run learns it from
                    // `describeTool` rather than from a prompt.
                    name: 'related_refs',
                    type: 'array',
                    required: false,
                    description:
                        'Other records this defect touches (chapter, plotline or summary ids), so the finding propagates across chapters (L-11a).'
                },
                {
                    name: 'why',
                    type: 'string',
                    required: false,
                    description: 'Optional: why this is worth the Author attention.'
                }
            ],
            enums: { cost: ['critical', 'major', 'minor', 'taste'] },
            // T-4: `expects` is spelled out rather than guessed. `raiseFinding` CREATES a row, so
            // there is nothing to compare-and-swap against.
            expects: {
                required: false,
                shape: '[{id, rev}]',
                note: 'this tool creates records, so it does not read-modify-write one'
            },
            // T-5, with §8.3's arg list honoured: the tool synthesises the reason when the agent
            // sends none (see the report's judgement calls).
            why: { required: false, field: 'why', note: 'T-5: every write records its reason' },
            permission: { writes: 'findings', level: 'write' },
            permission_rows: [
                {
                    artifact: 'findings',
                    writer: 'write',
                    editor: 'write_verify',
                    checker: 'write',
                    reader: 'write',
                    rules: ['D-16', 'D-33', 'D-34', 'D-35'],
                    note: 'any kind may raise one; the Editor confirms, disputes or rewrites it; the Author approves'
                }
            ],
            may_call_as_this_role: true,
            rule_ids: ['D-16', 'D-33', 'D-34', 'D-35']
        });
    });

    it('refuses a name outside §8 with a sample of the real names, never a guess (T-6c)', async () => {
        const result = await callAs(store, 'writer', 'describeTool', { name: 'editChater' });

        // The TOOL exists in the registry, so this is a bad argument (T-11) and not an unknown tool
        // (T-6c, which `execute` answers). The distinction tells the agent which fix to take.
        expect(result).toEqual({
            ok: false,
            refused: 'T-11',
            message: 'Rule: T-11 — no tool named "editChater" is registered on this session',
            error: 'Rule: T-11 — no tool named "editChater" is registered on this session',
            field: 'name',
            similar: [
                'editSummary',
                'createPlotline',
                'editPlotline',
                'createChapter',
                'editChapter',
                'deleteChapter',
                'updateDigest',
                'proposeChange',
                'listRevisions',
                'selectRevision',
                'requestMerge',
                'rejectAll'
            ],
            fix: 'call listTools for the full catalogue'
        });
    });
});
