/**
 * §7 as data: the permission table, the guards the matrix cannot express as a level, and the
 * refusal wording (§12 W2, T-1, T-1a).
 *
 * §7's columns are Author | Assistant | **Writer** | **Editor** | Checker/**Reader**. The Author
 * and the Assistant are not dispatched kinds, so this file pins the four columns the tool layer
 * enforces — cell for cell, in §7's row order — and then the rules the table cannot say as a
 * level: the two lock flags (P5, T-3c, L-7), the Author's spans (P9, T-2), the engine-owned state
 * fields (D-1), and the derived Digest (D-12a). T-1a demands the refusal be a teaching message, so
 * the rendered message and its `fix` are pinned as exact strings: an agent that reads "route the
 * job to a writer" can act on it, and one that reads "hand this to a editor" cannot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import type { CollectionName, RoleKind, Story, StoryPhase } from '../../shared/types';
import { createToolRuntime, type RunToolContext } from './index';
import {
    PERMISSION_ROWS,
    checkPermission,
    guardAuthorSpans,
    guardExpects,
    guardPlotlineWritable,
    guardStateWrite,
    guardSummaryWritable,
    levelFor,
    mayCallKind,
    permissionRefusal,
    permissionRow,
    permissionRowsFor
} from './permissions';
import { TOOL_BY_NAME } from './registry';
import { ToolRefusal } from './utilities';
import type { PermissionLevel, ToolDefinition, ToolExecutionContext } from './types';

/**
 * §7 transcribed row for row, in the spec's order: the artifact, the §4 collection its tools
 * write, and the four dispatched kinds' levels.
 *
 * Three readings of the spec's table are deliberate and are what this array pins:
 *  - §7's `cast`, `ledger` and `verdicts, findings` rows name two collections each, so they become
 *    two rows apiece;
 *  - §7's `ideas` — a discarded or selected one` row is the SAME collection, so it is carried as
 *    the `note` on the `ideas` row rather than as a second row the pipeline could never key on;
 *  - the last two rows are not in §7's table at all. `runs` needs a row because `delegate` files a
 *    sub-agent record (§4.13) and the web tools read run state (§4.14), and §8.2's `delegate` is
 *    in-run REASONING, so both cells are `recommend` — the level T-2b describes ("stays inside one
 *    run and produce one answer", never a dispatched Work Item).
 */
const SPEC_PERMISSION_MATRIX: Array<
    [string, string, PermissionLevel, PermissionLevel, PermissionLevel, PermissionLevel]
> = [
    ['stories.idea (the Seed)', 'stories', 'read', 'read', 'read', 'read'],
    ['summaries (prose)', 'summaries', 'write', 'read', 'read', 'read'],
    ['summaries.chapter_count', 'summaries', 'read', 'read', 'read', 'read'],
    ['ideas', 'ideas', 'read', 'verify', 'write', 'write'],
    ['plotlines', 'plotlines', 'write', 'read', 'read', 'read'],
    ['chapters.content (agent-written)', 'chapters', 'write', 'read', 'read', 'read'],
    ['chapters.content (Author-written span)', 'chapters', 'propose', 'read', 'read', 'read'],
    ['chapters.title/summary', 'chapters', 'write', 'read', 'read', 'read'],
    ['revisions', 'revisions', 'write', 'write', 'read', 'read'],
    ['cast', 'cast', 'write', 'read', 'read', 'read'],
    ['ledger', 'ledger', 'write', 'read', 'read', 'read'],
    ['digests', 'digests', 'read', 'read', 'read', 'read'],
    ['tasks', 'tasks', 'write', 'write', 'write', 'write'],
    ['verdicts', 'verdicts', 'write', 'write_verify', 'write', 'write'],
    ['findings', 'findings', 'write', 'write_verify', 'write', 'write'],
    ['selection_notes', 'revisions', 'read', 'write', 'read', 'read'],
    ['goals, criteria', 'goals', 'read', 'read', 'read', 'read'],
    ['stories.phase, stories.status, *.state', 'stories', 'read', 'recommend', 'read', 'read'],
    ['stories.summary_locked, stories.plotlines_locked, backtrack', 'stories', 'read', 'read', 'read', 'read'],
    ['templates, recipes', 'templates', 'read', 'read', 'read', 'read'],
    ['directives', 'directives', 'read', 'read', 'read', 'read'],
    ['proposals', 'proposals', 'write', 'write', 'write', 'write'],
    ['sub_agent_runs', 'runs', 'recommend', 'recommend', 'recommend', 'recommend'],
    ['runs', 'runs', 'read', 'read', 'read', 'read']
];

/**
 * The rows whose refusal must name a rule other than P10. §12 W2 names three of them outright
 * (a Reader's prose write as P10, an Editor's as L-19, a locked Summary as P5); §8 adds T-3c and
 * D-12a, and §7's Author-span row is P9.
 */
const SPEC_REFUSAL_RULES: Record<string, Partial<Record<RoleKind, string>>> = {
    'chapters.content (agent-written)': { editor: 'L-19', checker: 'P10', reader: 'P10' },
    // The lock guard below is the one W2 names (P5); this is the phase guard, which is what fires
    // while the Summary is still unlocked (§8.1: "phase `summary` only").
    'summaries (prose)': { writer: 'T-3c' },
    'chapters.content (Author-written span)': { writer: 'P9' },
    digests: { writer: 'D-12a', editor: 'D-12a', checker: 'D-12a', reader: 'D-12a' }
};

const KINDS: RoleKind[] = ['writer', 'editor', 'checker', 'reader'];

/** The guards read `store`, `story`, `storyId` and `role`; the rest of the context is irrelevant. */
function guardContext(store: Store, story: Story, role: RoleKind, storyId: string): ToolExecutionContext {
    return { store, story, storyId, role } as unknown as ToolExecutionContext;
}

describe('the §7 permission table', () => {
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

    it("is §7 transcribed cell for cell, in the spec's row order (T-1)", () => {
        expect(
            PERMISSION_ROWS.map(
                (row) =>
                    [row.artifact, row.collection, row.writer, row.editor, row.checker, row.reader] as (
                        | string
                        | PermissionLevel
                    )[]
            )
        ).toEqual(SPEC_PERMISSION_MATRIX);
    });

    it('carries the rule ids §12 W2 demands a refusal name (T-1a)', () => {
        const byArtifact = new Map(PERMISSION_ROWS.map((row) => [row.artifact, row.refusal_rules ?? {}]));
        for (const [artifact, rules] of Object.entries(SPEC_REFUSAL_RULES))
            expect({ artifact, rules: byArtifact.get(artifact) }).toEqual({ artifact, rules });
    });

    it("keys every row on a real §4 collection and quotes all of a collection's rows", () => {
        expect(PERMISSION_ROWS.map((row) => row.collection)).toEqual(SPEC_PERMISSION_MATRIX.map((row) => row[1]));
        // `describeTool` answers "what are the rules here?" with every row for the collection, and
        // a chapter has three: the two span kinds and the title/summary row (§7 splits them).
        expect(permissionRowsFor('chapters').map((row) => row.artifact)).toEqual([
            'chapters.content (agent-written)',
            'chapters.content (Author-written span)',
            'chapters.title/summary'
        ]);
        expect(permissionRowsFor('revisions').map((row) => row.artifact)).toEqual(['revisions', 'selection_notes']);
        // The FIRST row for a collection is the one a call is judged against, so §7's row ORDER is
        // load-bearing: a write to `stories` is judged by the Seed cell (`read`), which is why the
        // state fields are guarded by `guardStateWrite` (D-1) rather than by a level.
        expect(levelFor('editor', 'stories')).toBe('read');
        expect(permissionRow('chapters')!.artifact).toBe('chapters.content (agent-written)');
        expect(permissionRow('no_such_collection')).toBeUndefined();
    });

    it("decides a cell the way §7's prose says, including how the levels order", () => {
        // A `read` requirement is met by every kind whose cell is not `none` — §7 states read access
        // in prose ("everyone may read") rather than as a column.
        expect(KINDS.map((role) => checkPermission(role, 'chapters', 'read').allowed)).toEqual([
            true,
            true,
            true,
            true
        ]);
        // `verify` is the Editor's fact-check right (D-31). It is NOT a write, and a `write` does
        // not satisfy it, which is what stops a checker from verifying what it read.
        expect(checkPermission('editor', 'ideas', 'verify')).toEqual({
            allowed: true,
            level: 'verify',
            row: permissionRow('ideas')
        });
        expect(checkPermission('checker', 'ideas', 'verify').allowed).toBe(false);
        expect(checkPermission('editor', 'ideas', 'write').allowed).toBe(false);
        // `write_verify` satisfies both `write` and `verify`: the Editor's cell on findings, which
        // is how §8.2's `verifyFinding` (D-33) and `approveFinding` (D-34) pair is one row.
        expect(checkPermission('editor', 'findings', 'write').allowed).toBe(true);
        expect(checkPermission('writer', 'findings', 'write_verify').allowed).toBe(false);
        // `recommend` is the Editor's `markChapterDone` cell (L-10): a writer may recommend, a
        // reader-holds-only-read may not.
        expect(checkPermission('editor', 'runs', 'recommend').allowed).toBe(true);
        expect(checkPermission('writer', 'chapters', 'recommend').allowed).toBe(true);
        expect(checkPermission('writer', 'stories', 'recommend').allowed).toBe(false);
        // `propose` is weaker than `write`, so §7's Author-span cell really is propose-only.
        expect(checkPermission('writer', 'chapters', 'propose').allowed).toBe(true);
        // A collection with no row has no level for anybody.
        expect(levelFor('writer', 'no_such_collection')).toBe('none');
        expect(checkPermission('writer', 'no_such_collection', 'read')).toEqual({ allowed: false, level: 'none' });
    });

    it('refuses every kind writing the Digest, because the engine derives it (D-12a, D-13)', () => {
        expect(
            KINDS.map((role) => {
                const decision = checkPermission(role, 'digests', 'write');
                return { role, allowed: decision.allowed, level: decision.level };
            })
        ).toEqual([
            { role: 'writer', allowed: false, level: 'read' },
            { role: 'editor', allowed: false, level: 'read' },
            { role: 'checker', allowed: false, level: 'read' },
            { role: 'reader', allowed: false, level: 'read' }
        ]);
    });

    it('grants what §7 grants and only what §7 grants, tool by tool (P10, T-1b)', () => {
        // T-1b: a Reader's extra right is exactly one — `proposeIdea` — and it is not a write. The
        // checker holds the same `write` cell on `ideas`, so it may report one too.
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('proposeIdea')!))).toEqual([
            false,
            false,
            true,
            true
        ]);
        // §7's `ideas` cell makes the Editor the verifier (D-31/D-27): `verifyIdea` is its tool
        // alone, and the Editor marks an idea unverifiable through the same verdict.
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('verifyIdea')!))).toEqual([
            false,
            true,
            false,
            false
        ]);
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('markUnverifiable')!))).toEqual([
            false,
            false,
            true,
            true
        ]);
        // §8.4: "`editCast` is Writer-only", registered everywhere and refused for the rest (T-1a).
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('editCast')!))).toEqual([
            true,
            false,
            false,
            false
        ]);
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('editLedger')!))).toEqual([
            true,
            false,
            false,
            false
        ]);
        // §7 gives the Writer `write` on `revisions` because it CREATES them through `editChapter`;
        // choosing between drafts is the Editor's alone (T-3b, D-29), so the tool narrows the row.
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('selectRevision')!))).toEqual([
            false,
            true,
            false,
            false
        ]);
        // Nobody at all — the tool exists so that the refusal exists (D-12a).
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('updateDigest')!))).toEqual([
            false,
            false,
            false,
            false
        ]);
        // §7's `tasks` and `verdicts, findings` rows are `write` for all four kinds: a reviewer
        // files the fix it saw rather than making it itself (D-11, §8.3).
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('createTask')!))).toEqual([
            true,
            true,
            true,
            true
        ]);
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('submitVerdict')!))).toEqual([
            true,
            true,
            true,
            true
        ]);
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('markChapterDone')!))).toEqual([
            true,
            true,
            true,
            true
        ]);
        // T-6b: web access is not a right at all — everyone has it.
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('searchWeb')!))).toEqual([
            true,
            true,
            true,
            true
        ]);
        // T-6c: the discovery pair is a read, so "what can this role reach?" is answerable from
        // inside any session.
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('listTools')!))).toEqual([
            true,
            true,
            true,
            true
        ]);
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('describeTool')!))).toEqual([
            true,
            true,
            true,
            true
        ]);
        // T-12: the gap report is a queue entry, so every kind can file one.
        expect(KINDS.map((role) => mayCallKind(role, TOOL_BY_NAME.get('reportGap')!))).toEqual([
            true,
            true,
            true,
            true
        ]);
    });

    it('renders a refusal naming the rule, the artifact, the level held, and the way out (T-1a)', () => {
        const editChapter: ToolDefinition = TOOL_BY_NAME.get('editChapter')!;
        // §12 W2: a Reader's prose write is refused naming P10. The projection is the whole
        // contract — `rule` becomes `refused` for T-1b's tally, `message` is what the model reads,
        // and `details` is what it re-sends. (`message` is non-enumerable on an Error, so the three
        // fields are named rather than spread.)
        const readerRefusal = permissionRefusal(
            { role: 'reader', storyId: 'story_1' },
            editChapter,
            'read',
            permissionRow('chapters')
        );
        expect({ rule: readerRefusal.rule, message: readerRefusal.message, details: readerRefusal.details }).toEqual({
            rule: 'P10',
            message:
                'a reader may not editChapter on chapters.content (agent-written): §7 gives a reader "read" there. Route the job to a writer',
            details: {
                story_id: 'story_1',
                artifact: 'chapters.content (agent-written)',
                role: 'reader',
                level: 'read',
                required: 'write',
                criterion_refs: ['L-19', 'D-37', 'P7'],
                fix: 'hand this to a writer, or file a task and let the loop route it'
            }
        });
        // §12 W2: the Editor's prose write names L-19, not the generic row rule — and the article
        // is grammatical, because the sentence is read by the model as §7 itself.
        const editorRefusal = permissionRefusal(
            { role: 'editor', storyId: 'story_1' },
            editChapter,
            'read',
            permissionRow('chapters')
        );
        expect({ rule: editorRefusal.rule, message: editorRefusal.message }).toEqual({
            rule: 'L-19',
            message:
                'an editor may not editChapter on chapters.content (agent-written): §7 gives an editor "read" there. Route the job to a writer'
        });
        // An Editor's Summary write is refused by the row, and the fix points at the kind that holds
        // §7's `summaries (prose)` cell.
        const summaryRefusal = permissionRefusal(
            { role: 'editor', storyId: 'story_1' },
            TOOL_BY_NAME.get('editSummary')!,
            'read',
            permissionRow('summaries')
        );
        expect({ rule: summaryRefusal.rule, message: summaryRefusal.message, fix: summaryRefusal.details.fix }).toEqual(
            {
                rule: 'P10',
                message:
                    'an editor may not editSummary on summaries (prose): §7 gives an editor "read" there. Route the job to a writer',
                fix: 'hand this to a writer, or file a task and let the loop route it'
            }
        );
        // The Digest has no kind holding the right, so the fix cannot be "find another role" — the
        // row supplies the one call that works (D-12a's refusal, D-13's route).
        const digestRefusal = permissionRefusal(
            { role: 'writer', storyId: 'story_1' },
            TOOL_BY_NAME.get('updateDigest')!,
            'read',
            permissionRow('digests')
        );
        expect({ rule: digestRefusal.rule, message: digestRefusal.message, fix: digestRefusal.details.fix }).toEqual({
            rule: 'D-12a',
            message:
                'a writer may not updateDigest on digests: §7 gives a writer "read" there. Route the job to the Author, in the dashboard',
            fix: 'raiseFinding with criterion_ref "digest_gap" and the reason the Digest is wrong (D-13)'
        });
        // A collection with no row at all is refused as `none`, with no §7 citations to quote.
        // (No §4 collection is unrowed today, so the orphan row is the synthetic case: it is what
        // a future §4 collection looks like before §7 has a cell for it.)
        const orphanRefusal = permissionRefusal(
            { role: 'writer', storyId: 'story_1' },
            { name: 'editGhost', writes: 'ghosts' as CollectionName, level: 'write' },
            'none'
        );
        expect({ rule: orphanRefusal.rule, message: orphanRefusal.message, details: orphanRefusal.details }).toEqual({
            rule: 'P10',
            message:
                'a writer may not editGhost on ghosts: §7 gives a writer "none" there. Route the job to the Author, in the dashboard',
            details: {
                story_id: 'story_1',
                artifact: 'ghosts',
                role: 'writer',
                level: 'none',
                required: 'write',
                fix: 'this is an Author-only edit'
            }
        });
    });

    it('refuses the locked Summary as P5 and the wrong phase as T-3c (P5, T-3c, D-3, L-30)', () => {
        const editSummary: ToolDefinition = TOOL_BY_NAME.get('editSummary')!;
        const current = () => guardContext(store, store.stories.require(story.id), 'writer', story.id);

        // Phase ①, unlocked: the Writer's one allowed write (T-3c's other half).
        store.stories.update(story.id, { phase: 'summary' as StoryPhase }, { why: 'seed: phase 1' });
        expect(guardSummaryWritable(current(), editSummary)).toBeNull();

        // Phase ③: the same call is refused naming T-3c, because the Summary is not this phase's
        // write (D-3) — the message says which phase it is in, so the run changes course.
        store.stories.update(story.id, { phase: 'chapters' as StoryPhase }, { why: 'seed: phase 3' });
        const phaseRefusal = guardSummaryWritable(current(), editSummary) as ToolRefusal;
        expect({ rule: phaseRefusal.rule, message: phaseRefusal.message, details: phaseRefusal.details }).toEqual({
            rule: 'T-3c',
            message:
                "the Story is in phase `chapters`, and `editSummary` is the Writer's only write during phase `summary` (D-3)",
            details: {
                story_id: story.id,
                phase: 'chapters',
                artifact: 'summaries',
                fix: 'work the current phase, or file a finding if the Summary itself is wrong'
            }
        });

        // The lock wins over the phase. §12 W2's "a write to a locked Summary is refused naming P5"
        // has to hold in phase ① as well, where T-3c would otherwise be the louder-sounding rule.
        store.stories.update(story.id, { phase: 'summary' as StoryPhase, summary_locked: true }, { why: 'seed: lock' });
        const locked = guardSummaryWritable(current(), editSummary) as ToolRefusal;
        expect({ rule: locked.rule, message: locked.message, details: locked.details }).toEqual({
            rule: 'P5',
            message: 'the Summary is locked (`summary_locked` is true), so it is read-only for every agent',
            details: {
                story_id: story.id,
                artifact: 'summaries',
                field: 'summary_locked',
                fix: 'a Writer that wants the Summary changed files a finding; the Author decides whether it is worth a backtrack (D-25)'
            }
        });
    });

    it('diverts a locked plotline into a proposal instead of refusing it (L-7, §7\'s "then propose")', () => {
        const current = () => guardContext(store, store.stories.require(story.id), 'writer', story.id);
        expect(guardPlotlineWritable(current(), false)).toBeNull();
        store.stories.update(story.id, { plotlines_locked: true }, { why: 'seed: plotline lock' });
        expect(guardPlotlineWritable(current(), false)).toBe('propose');
        // §4.3's per-plotline mirror counts too, or one locked contract would keep leaking writes.
        store.stories.update(story.id, { plotlines_locked: false }, { why: 'seed: unlock' });
        expect(guardPlotlineWritable(current(), true)).toBe('propose');
    });

    it('sends an Author-written span to a proposal for the Writer and refuses it for the rest (P9, T-2, D-37a)', () => {
        const ctx = (role: RoleKind) => guardContext(store, story, role, story.id);
        // T-2: the guard works at section granularity, so only the Author's span is frozen and the
        // Writer keeps its own sections.
        expect(guardAuthorSpans(ctx('writer'), ['section_2'], ['section_1'], 'chapters:chapter_1')).toBeNull();
        expect(guardAuthorSpans(ctx('writer'), ['section_2'], ['section_2'], 'chapters:chapter_1')).toBe('propose');
        // The report kinds hold no write on chapters at all, so the ROW refuses them first and this
        // guard abstains — two refusals for one call would teach the wrong lesson (T-1a).
        expect(guardAuthorSpans(ctx('checker'), ['section_2'], ['section_2'], 'chapters:chapter_1')).toBeNull();
        expect(guardAuthorSpans(ctx('reader'), ['section_2'], ['section_2'], 'chapters:chapter_1')).toBeNull();
        // The Editor is the case the row cannot express: its `chapters.title/summary` cell is a read
        // for prose, but a title change touching an Author span is P9, not a generic refusal.
        const spanRefusal = guardAuthorSpans(
            ctx('editor'),
            ['section_2'],
            ['section_2'],
            'chapters:chapter_1'
        ) as ToolRefusal;
        expect({ rule: spanRefusal.rule, message: spanRefusal.message, details: spanRefusal.details }).toEqual({
            rule: 'P9',
            message:
                'section section_2 of chapters:chapter_1 was written by the Author, so an editor may only propose against it',
            details: {
                story_id: story.id,
                ref: 'chapters:chapter_1',
                section_id: 'section_2',
                fix: 'proposeChange with target_field "sections"'
            }
        });
    });

    it('refuses an agent moving a state field, because the engine owns the machine (D-1)', () => {
        const ctx = guardContext(store, story, 'writer', story.id);
        // The engine's own writes arrive with the field already at its new value, so only a
        // REQUESTED move is a violation.
        expect(guardStateWrite(ctx, 'drafting', 'drafting')).toBeNull();
        expect(guardStateWrite(ctx, undefined, 'drafting')).toBeNull();
        const moved = guardStateWrite(ctx, 'done', 'drafting') as ToolRefusal;
        expect({ rule: moved.rule, message: moved.message, details: moved.details }).toEqual({
            rule: 'D-1',
            message:
                'a writer may not change `state` from "drafting" to "done": the loop engine and the Author own the state machine',
            details: {
                story_id: story.id,
                field: 'state',
                from: 'drafting',
                to: 'done',
                fix: 'file a task or a verdict and let the loop move the state'
            }
        });
        // §7's `*.state` row is the same rule by another name: `pending_kind` is the engine's.
        expect((guardStateWrite(ctx, 'drained', 'none', 'pending_kind') as ToolRefusal).rule).toBe('D-1');
    });

    it('refuses an unguarded read-modify-write before anything is touched (T-4)', () => {
        const editChapter: ToolDefinition = TOOL_BY_NAME.get('editChapter')!;
        const ctx = {
            store,
            story,
            storyId: story.id,
            role: 'writer',
            tool: editChapter
        } as unknown as ToolExecutionContext;
        // No `expects`, and an `expects` with no rev, are both unguarded.
        expect((guardExpects(ctx, []) as ToolRefusal).rule).toBe('T-4');
        expect((guardExpects(ctx, [{ id: 'chapter_1' } as never]) as ToolRefusal).rule).toBe('T-4');
        expect(guardExpects(ctx, [{ id: 'chapter_1', rev: 3 }])).toBeNull();
        // A report tool CREATES rows, so it has nothing to compare-and-swap against (T-4's scope).
        const reportTool = { ...editChapter, expectsArg: false } as ToolDefinition;
        expect(guardExpects({ ...ctx, tool: reportTool } as unknown as ToolExecutionContext, [])).toBeNull();
    });

    it('validates the body before the row, and guards the Story state after it (T-11, P8, D-2a)', async () => {
        const runtime = createToolRuntime(store);
        const reader: RunToolContext = runtime.createContext({
            storyId: story.id,
            roleKind: 'reader',
            roleName: 'reader_1',
            runId: 'run_reader'
        });

        // A malformed call is refused naming the field BEFORE the permission row, or an agent gets
        // a permission lesson it cannot act on yet (T-11). The result carries the field-by-field
        // issues and `describeTool`'s shape, so the fix costs one turn (T-6c).
        const malformed = await runtime.execute(reader, 'editChapter', {
            section_id: 'section_1',
            content: 'x',
            why: 'A reader tries.',
            expects: []
        });
        expect({ refused: malformed.refused, tool: malformed.tool, issues: malformed.issues }).toEqual({
            refused: 'T-11',
            tool: 'editChapter',
            issues: [{ field: 'chapter_id', expected: 'string' }]
        });

        // P8: the Author paused the Story, so a write is refused even for the Writer, while reads
        // stay open so the crew panel remains readable.
        store.stories.update(
            story.id,
            { status: 'stopped', author_stop: true, status_reason: 'the Author paused it' },
            { why: 'seed: stop' }
        );
        const writer: RunToolContext = runtime.createContext({
            storyId: story.id,
            roleKind: 'writer',
            roleName: 'writer_1',
            runId: 'run_writer'
        });
        const stopped = await runtime.execute(writer, 'editSummary', {
            premise: 'Rewritten during a pause.',
            expects: [{ id: 'summary_1', rev: 1 }],
            why: 'Trying anyway.'
        });
        expect({ refused: stopped.refused, status: stopped.status, author_stop: stopped.author_stop }).toEqual({
            refused: 'P8',
            status: 'stopped',
            author_stop: true
        });
        expect((await runtime.execute(writer, 'readSeed', {})).ok).toBe(true);
    });
});
