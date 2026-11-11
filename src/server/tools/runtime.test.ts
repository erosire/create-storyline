/**
 * W2 acceptance for the tool pipeline (§8, §12 W2).
 *
 * Every assertion is an exact value: the rule id a refusal carries, the row it came from, the
 * record a write produced, and the journal entry behind it. The §12 W2 sentence names four
 * refusals by rule (a Reader's prose write as P10, an Editor's prose write as L-19, a locked
 * Summary as P5, a cross-Story ref as T-3) — those are pinned first, then the pipeline rules the
 * spec pins (T-4, T-5, T-6a, T-6c, T-8, T-11, T-12) and the behaviour rules (§7, D-1, D-12a,
 * D-15, D-16, D-26/D-32, D-31, P9, D-37).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import type { Chapter, ChapterSection, Revision, RoleKind, Story, StoryPhase } from '../../shared/types';
import type { ToolSchema } from '../llm/client';
import { createToolRuntime, type RunToolContext, type ToolResult, type ToolRuntime } from './index';
import type { RunSession } from './types';

/** The exact section shape §4.4 stores; `content` is derived, never stored (D-7). */
const WRITER_SECTION: ChapterSection = { id: 'section_1', text: 'The first written span.', origin: 'writer' };
const AUTHOR_SECTION: ChapterSection = { id: 'section_2', text: 'The Author keeps this line.', origin: 'author' };

/** Builds a Story row with the exact §4.1 defaults a fresh Story carries. */
function seedStory(store: Store, title: string, phase: StoryPhase = 'chapters'): Story {
    return store.stories.create(
        {
            title,
            phase,
            idea: 'A lighthouse keeper learns the light was never the point.',
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
}

/** Seeds one Story with a Summary, a plotline, and one chapter whose first section is writable. */
function seedWorld(): { store: Store; story: Story; chapter: Chapter } {
    const store = Store.empty();
    const story = seedStory(store, 'The Light Keeper');
    store.summaries.create(
        { story_id: story.id, chapter_count: 1, premise: 'A keeper, a light, a debt.', locked: false },
        { why: 'seed: summary created' }
    );
    const plotline = store.plotlines.create(
        {
            story_id: story.id,
            order: 1,
            heading: 'The keeper signs off',
            must_happen: 'He climbs the tower.',
            must_change: 'He knows the light is his own fault.',
            contract_locked: false,
            aligned: false,
            needs_recheck: false
        },
        { why: 'seed: plotline created' }
    );
    const chapter = store.chapters.create(
        {
            story_id: story.id,
            plotline_ref: plotline.id,
            order: 1,
            title: 'Sign off',
            summary: 'The keeper climbs.',
            sections: [WRITER_SECTION, AUTHOR_SECTION],
            state: 'drafting',
            author_locked: false,
            round: 0
        },
        { why: 'seed: chapter created' }
    );
    return { store, story, chapter };
}

/** A session for one role kind on one Story (T-3 binds the id; T-0 binds the kind). */
/**
 * A session for one role kind on one Story (T-3 binds the id, T-0 binds the kind).
 *
 * `roleKind` is a plain string here because T-0's acceptance calls with an unrecognised kind
 * (`writter`); the cast is what lets that case through, and the pipeline is what refuses it.
 */
function sessionFor(
    storyId: string,
    roleKind: string,
    overrides: { roleName?: string; runId?: string } = {}
): RunSession {
    return {
        storyId,
        roleKind: roleKind as RoleKind,
        roleName: overrides.roleName ?? `${roleKind}_1`,
        runId: overrides.runId ?? `run_${roleKind}`
    };
}

/**
 * Seeds one competing draft of the test chapter (§4.15). The store mints the ids, so the first
 * draft a test creates is `revision_1` and the next is `revision_2` — the D-22 tests below name
 * them exactly rather than reading them back.
 */
function seedRevision(store: Store, storyId: string, unitRef: string, text: string): Revision {
    return store.revisions.create(
        {
            story_id: storyId,
            unit_kind: 'chapter',
            unit_ref: unitRef,
            // D-7: a chapter draft's body is sections, and the install replaces the unit's sections.
            body: { sections: [{ id: 'section_1', text, origin: 'writer' }] },
            state: 'competing',
            verdict_refs: []
        },
        { why: 'seed: competing draft' }
    ) as Revision;
}

/**
 * D-38/U-8d's exact appended note: the agent's own rule sentence, then `' | '`, then the panel's
 * split, which is what `withDissent`/`dissentSentence` in `src/server/run/panel.ts` composes and
 * what `selectRevision` must therefore accept and store unchanged.
 */
const DISSENT_NOTE =
    'It keeps the bell under the water. | 2 of 3 preferred revision_1; selected revision_2 on the must_happen rule';

describe('the W2 call pipeline', () => {
    let store: Store;
    let story: Story;
    let chapter: Chapter;

    beforeEach(() => {
        const world = seedWorld();
        store = world.store;
        story = world.story;
        chapter = world.chapter;
    });

    afterEach(() => {
        delete process.env.EXA_API_KEY;
        delete process.env.TAVILY_API_KEY;
    });

    /** Runs one call as one role kind, with a context built the way the run layer builds it. */
    async function call(
        roleKind: string,
        name: string,
        args: Record<string, unknown>,
        storyId?: string
    ): Promise<ToolResult> {
        const runtime = createToolRuntime(store);
        const context: RunToolContext = runtime.createContext(sessionFor(storyId ?? story.id, roleKind));
        return runtime.execute(context, name, args);
    }

    // ── §12 W2's named refusals ─────────────────────────────────────────────

    it("refuses a Reader's prose write naming P10, and names the row it came from", async () => {
        const result = await call('reader', 'editChapter', {
            chapter_id: chapter.id,
            section_id: WRITER_SECTION.id,
            content: 'A reader tried to write prose.',
            expects: [{ id: chapter.id, rev: chapter.rev }],
            why: 'Because the brief said to.'
        });

        expect(result).toEqual({
            ok: false,
            refused: 'P10',
            message:
                'Rule: P10 — a reader may not editChapter on chapters.content (agent-written): §7 gives a reader "read" there. Route the job to a writer',
            error: 'Rule: P10 — a reader may not editChapter on chapters.content (agent-written): §7 gives a reader "read" there. Route the job to a writer',
            story_id: story.id,
            artifact: 'chapters.content (agent-written)',
            role: 'reader',
            level: 'read',
            required: 'write',
            criterion_refs: ['L-19', 'D-37', 'P7'],
            fix: 'hand this to a writer, or file a task and let the loop route it'
        });
        // T-1a: the call existed and was refused; the record is untouched.
        expect(store.chapters.require(chapter.id).sections).toEqual([WRITER_SECTION, AUTHOR_SECTION]);
    });

    it("refuses an Editor's prose write naming L-19, not the generic P10", async () => {
        const result = await call('editor', 'editChapter', {
            chapter_id: chapter.id,
            section_id: WRITER_SECTION.id,
            content: 'The Editor tried to write the prose.',
            expects: [{ id: chapter.id, rev: chapter.rev }],
            why: 'It read badly.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('L-19');
        expect(result.message).toBe(
            'Rule: L-19 — an editor may not editChapter on chapters.content (agent-written): §7 gives an editor "read" there. Route the job to a writer'
        );
        expect(result.criterion_refs).toEqual(['L-19', 'D-37', 'P7']);
        expect(store.chapters.require(chapter.id).sections).toEqual([WRITER_SECTION, AUTHOR_SECTION]);
    });

    it('refuses a Summary write after the lock naming P5, in phase `summary` and by a Writer', async () => {
        // The Story is in phase ① and the Author has locked the Summary: only the lock should
        // decide here, so the rule is P5 and not T-3c (the phase test is the other one).
        store.stories.update(story.id, { phase: 'summary', summary_locked: true }, { why: 'seed: locked summary' });

        const result = await call('writer', 'editSummary', {
            premise: 'A rewrite the lock should stop.',
            expects: [{ id: 'summary_1', rev: 1 }],
            why: 'The premise reads thin.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('P5');
        expect(result.message).toBe(
            'Rule: P5 — the Summary is locked (`summary_locked` is true), so it is read-only for every agent'
        );
        expect(result.field).toBe('summary_locked');
        expect(store.summaries.require('summary_1').premise).toBe('A keeper, a light, a debt.');
    });

    it('refuses a write outside phase `summary` naming T-3c, when the lock is not the blocker', async () => {
        const result = await call('writer', 'editSummary', {
            premise: 'Rewritten in the wrong phase.',
            expects: [{ id: 'summary_1', rev: 1 }],
            why: 'Trying anyway.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('T-3c');
        expect(result.phase).toBe('chapters');
    });

    it('refuses a ref that belongs to another Story naming T-3 (T-3 scope)', async () => {
        const other = seedStory(store, 'Other Story');
        const otherChapter = store.chapters.create(
            {
                story_id: other.id,
                order: 1,
                title: 'Elsewhere',
                sections: [WRITER_SECTION],
                state: 'drafting',
                author_locked: false,
                round: 0
            },
            { why: 'seed: other chapter' }
        );

        const result = await call('writer', 'readChapter', { chapter_id: otherChapter.id });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('T-3');
        expect(result).toMatchObject({
            ref: otherChapter.id,
            expected_kinds: ['chapters'],
            fix: 're-read chapters and pass a record from this Story'
        });
    });

    // ── T-5, T-4, T-8: the write discipline ────────────────────────────────

    it('refuses a write with no why naming T-5, before any other rule', async () => {
        const result = await call('writer', 'editChapter', {
            chapter_id: chapter.id,
            section_id: WRITER_SECTION.id,
            content: 'Prose with no reason attached.',
            expects: [{ id: chapter.id, rev: chapter.rev }]
        });

        expect(result).toEqual({
            ok: false,
            refused: 'T-5',
            message: 'Rule: T-5 — editChapter is a write, so it must carry why — every write records its reason',
            error: 'Rule: T-5 — editChapter is a write, so it must carry why — every write records its reason',
            tool: 'editChapter',
            field: 'why',
            fix: 're-send with a one-line why, then the write will be attributed (P11)'
        });
    });

    it('records the why and the commit label on the write (T-5, P11)', async () => {
        const result = await call('writer', 'editChapter', {
            chapter_id: chapter.id,
            section_id: WRITER_SECTION.id,
            content: 'Rewritten with a reason.',
            expects: [{ id: chapter.id, rev: chapter.rev }],
            why: 'The opening paragraph was vague.'
        });

        expect(result.ok).toBe(true);
        // D-18: the run-log line names the chapter by number and the span that moved. T-8: the
        // payload carries the post-write rev so the next call needs no re-read.
        expect(result.summary).toBe('Chapter 1 section section_1 written');
        expect(result.rev).toBe(2);
        expect(result.data).toEqual({
            id: 'chapter_1',
            order: 1,
            title: 'Sign off',
            section_id: 'section_1',
            // D-7: the write lands in `sections` (the derived `content` is never a field).
            fields_written: ['sections'],
            // The count is the whole chapter's — `content` is the join over sections (D-7).
            word_count: 9,
            section_count: 2,
            current_rev: 2,
            next: 'Keep working the queue — a checker run judges this chapter and reports with submitVerdict.'
        });

        const events = store.journal.filter((event) => event.collection === 'chapters' && event.op === 'update');
        expect(events.length).toBe(1);
        expect(events[0].commit_label).toBe('tool:editChapter');
        expect(events[0].attribution).toEqual({
            run_ref: 'run_writer',
            author: false,
            assistant: false,
            why: 'The opening paragraph was vague.'
        });
    });

    it('rejects a stale expects and returns the CURRENT record (T-4)', async () => {
        const result = await call('writer', 'editChapter', {
            chapter_id: chapter.id,
            section_id: WRITER_SECTION.id,
            content: 'Written over someone else\u2019s change.',
            expects: [{ id: chapter.id, rev: 1 }],
            why: 'Racing another run.'
        });
        // First the chapter moves under the call.
        store.chapters.update(
            chapter.id,
            { summary: 'Moved by another run.' },
            { run_ref: null, why: 'other run wrote first' }
        );
        const conflict = await call('writer', 'editChapter', {
            chapter_id: chapter.id,
            section_id: WRITER_SECTION.id,
            content: 'Now stale.',
            expects: [{ id: chapter.id, rev: 1 }],
            why: 'Racing again.'
        });

        // The first call was still valid at rev 1, so it succeeded; the second is the conflict.
        expect(result.ok).toBe(true);
        expect(conflict.ok).toBe(false);
        expect(conflict.refused).toBe('T-4');
        expect(conflict.cas_conflict).toBe(true);
        expect(conflict.currents).toEqual([{ id: chapter.id, record: store.chapters.require(chapter.id) }]);
        expect(conflict.message).toBe(
            'Rule: T-4 — re-read the record and re-send the write with an expects that matches it.'
        );
    });

    it('refuses a read-modify-write call that sends no expects (T-4)', async () => {
        const result = await call('writer', 'editChapter', {
            chapter_id: chapter.id,
            section_id: WRITER_SECTION.id,
            content: 'Unguarded write.',
            why: 'No expects sent.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('T-4');
        expect(result.field).toBe('expects');
    });

    it('names the rev a read saw (T-8)', async () => {
        const result = await call('checker', 'readChapter', { chapter_id: chapter.id });

        expect(result.ok).toBe(true);
        expect(result.rev).toBe(1);
        expect((result.data as { content: string }).content).toBe(
            'The first written span.\n\nThe Author keeps this line.'
        );
        expect((result.data as { sections: ChapterSection[] }).sections.map((section) => section.origin)).toEqual([
            'writer',
            'author'
        ]);
    });

    // ── T-6a / T-6c: the catalogue every session holds ──────────────────────

    it('refuses an unknown tool naming T-6c and points at the catalogue', async () => {
        const result = await call('writer', 'editChaper', { chapter_id: chapter.id, why: 'typo' });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('T-6c');
        // The nearest name is the real verb the agent mangled, and the rest are the other `edit*`
        // tools — the point is that the fix is obvious in one turn (T-6c).
        expect((result.similar as string[]).slice(0, 3)).toEqual(['editChapter', 'editCast', 'editLedger']);
        // §8.1 (8) + §8.2 (10) + §8.3 (6) + §8.4 (17) + §8.5 (4). Every session holds all of them
        // whatever its kind (T-6a), so the count is itself a conformance number.
        expect(result.catalogue_size).toBe(45);
    });

    it('refuses an unknown role kind naming T-0 rather than defaulting it (T-0)', async () => {
        const result = await call('writter', 'readSeed', {});

        expect(result).toMatchObject({
            ok: false,
            refused: 'T-0',
            role_kind: 'writter',
            expected_kinds: ['writer', 'editor', 'reader', 'checker']
        });
    });

    // ── §7 rows the engine cannot express as a level ────────────────────────

    it('refuses updateDigest for every role naming D-12a, and names the digest_gap fix (D-12a, D-13)', async () => {
        for (const role of ['writer', 'editor', 'checker', 'reader']) {
            const result = await call(role, 'updateDigest', {
                body: 'A rewrite the crew is not allowed to make.',
                expects: [{ id: story.id, rev: story.rev }],
                why: 'The digest missed the fire.'
            });

            expect({ role, refused: result.refused }).toEqual({ role, refused: 'D-12a' });
            // D-13: the row cannot be satisfied by another kind, so the refusal names the only call
            // that works instead of pointing at a role. U-3a: the accepted hole is a `digest_gap`
            // FINDING ref, not a task kind — §4.7's Task has no `kind`, so the fix has to name the
            // field that actually carries it.
            expect(result.fix).toBe(
                'raiseFinding with criterion_ref "digest_gap" and the reason the Digest is wrong (D-13)'
            );
        }
        expect(store.digests.list().length).toBe(0);
    });

    it('files a signoff task on markChapterDone and changes no chapter state (D-1, L-10)', async () => {
        const result = await call('checker', 'markChapterDone', { chapter_id: chapter.id });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            chapter_id: 'chapter_1',
            chapter_state: 'drafting',
            task_id: 'task_1',
            open_findings: 0,
            state_changed: false
        });
        expect(store.chapters.require(chapter.id).state).toBe('drafting');
        expect(store.tasks.require('task_1')).toMatchObject({
            kind: 'signoff',
            title: 'Sign off chapter 1: Sign off',
            owner_role: 'author',
            state: 'open',
            priority: 45
        });
    });

    it('files a capability_gap task on reportGap and writes no artifact (T-12)', async () => {
        const before = store.journal.length;
        const result = await call('reader', 'reportGap', {
            job: 'Compare this chapter against the Author\u2019s earlier draft.',
            needed: 'A read of archived drafts.',
            tried: 'Read the current draft and the digest instead.',
            why: 'No tool reaches archived drafts.'
        });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            job: 'Compare this chapter against the Author\u2019s earlier draft.',
            needed: 'A read of archived drafts.',
            tried: 'Read the current draft and the digest instead.',
            task_id: 'task_1',
            owner_role: 'author'
        });
        expect(store.tasks.require('task_1')).toMatchObject({
            kind: 'capability_gap',
            owner_role: 'author',
            priority: 60
        });
        expect(store.chapters.list().length).toBe(1);
        expect(store.journal.filter((event) => event.commit_label === 'tool:reportGap').length).toBe(1);
        expect(store.journal.length).toBeGreaterThan(before);
    });

    it('refuses a second identical reportGap as a repeat instead of queueing it twice (T-12, T-24)', async () => {
        const args = {
            job: 'Read the archived drafts.',
            needed: 'Archive access.',
            tried: 'Read the digest.',
            why: 'Nothing else reaches them.'
        };
        const first = await call('reader', 'reportGap', args);
        const second = await call('reader', 'reportGap', args);

        expect(first.repeat).toBeUndefined();
        expect(second).toMatchObject({ ok: true, repeat: true, task_id: 'task_1' });
        expect(store.tasks.list().length).toBe(1);
    });

    it('refuses a checker verifying an Idea naming P10 — verification is the Editor row (D-31)', async () => {
        const idea = store.ideas.create(
            {
                story_id: story.id,
                phase: 'chapters',
                body: 'The keeper should not survive chapter 1.',
                kind: 'possibility',
                author: 'reader_1',
                sources: [],
                fingerprint: 'fp_test',
                seen_count: 1,
                state: 'proposed'
            },
            { why: 'seed: idea' }
        );

        const result = await call('checker', 'verifyIdea', {
            idea_id: idea.id,
            verdict: 'verified',
            evidence: 'Checked against the Summary promise.',
            meets_guidelines: true,
            why: 'It holds up.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('P10');
        expect(result.message).toBe(
            'Rule: P10 — a checker may not verifyIdea on ideas: §7 gives a checker "write" there. Route the job to an editor'
        );
    });

    it('dedupes a repeated finding by bumping seen_count instead of a second row (D-16)', async () => {
        const args = {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_1 section_2: "he already knew"',
            cost: 'major',
            why: 'It breaks the promise of the first chapter.'
        };
        const first = await call('checker', 'raiseFinding', args);
        const second = await call('checker', 'raiseFinding', args);

        expect(first.data).toMatchObject({ id: 'finding_1', state: 'unconfirmed', seen_count: 1, cost: 'major' });
        expect(second).toMatchObject({ ok: true, repeat: true, finding_id: 'finding_1' });
        expect(store.findings.list().length).toBe(1);
        expect(store.findings.require('finding_1').seen_count).toBe(2);
        expect(store.findings.require('finding_1').state).toBe('unconfirmed');
    });

    it('reports an already-decided Idea instead of re-opening it (D-32, D-26)', async () => {
        store.ideas.create(
            {
                story_id: story.id,
                phase: 'chapters',
                body: 'The light should fail on page one.',
                kind: 'direction',
                author: 'reader_1',
                sources: [],
                fingerprint: 'fp_decided',
                seen_count: 1,
                state: 'discarded',
                selection_note: 'It removes the whole tension.'
            },
            { why: 'seed: decided idea' }
        );

        const result = await call('reader', 'proposeIdea', {
            phase: 'chapters',
            body: 'The light should fail on page one.',
            kind: 'direction',
            sources: [],
            why: 'It would sharpen the opening.'
        });

        expect(result).toMatchObject({ ok: true, repeat: true, idea_id: 'idea_1' });
        expect((result.notes as string[])[0]).toContain('Rule D-32');
        expect(store.ideas.list().length).toBe(1);
        expect(store.ideas.require('idea_1').state).toBe('discarded');
    });

    it('files a proposal instead of rewriting a span the Author wrote (P9, T-2)', async () => {
        const result = await call('writer', 'editChapter', {
            chapter_id: chapter.id,
            section_id: AUTHOR_SECTION.id,
            content: 'The Author keeps this line, improved.',
            expects: [{ id: chapter.id, rev: chapter.rev }],
            why: 'The line can be tighter.'
        });

        expect(result.ok).toBe(true);
        expect(result.summary).toBe('Chapter 1 change filed as proposal proposal_1 (P9)');
        expect(result.data).toEqual({
            proposal_id: 'proposal_1',
            id: 'chapter_1',
            target_ref: 'chapter_1',
            target_field: 'sections',
            state: 'pending',
            proposed: true,
            locked_sections: ['section_2'],
            // Nothing was written, so the rev the call reports is still the one it read (T-8).
            current_rev: 1
        });
        expect(store.chapters.require(chapter.id).sections).toEqual([WRITER_SECTION, AUTHOR_SECTION]);
        expect(store.proposals.require('proposal_1')).toMatchObject({
            target_ref: 'chapter_1',
            target_field: 'sections',
            state: 'pending'
        });
    });

    // ── T-11 and D-15: validation inside the tool ───────────────────────────

    it('refuses a raiseFinding with no cost, naming the enum set (T-11)', async () => {
        const result = await call('checker', 'raiseFinding', {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'A defect with no cost dial',
            evidence: 'chapter_1 section_1',
            why: 'It needs triage.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('T-11');
        expect(result.issues).toEqual([{ field: 'cost', expected: 'one of critical | major | minor | taste' }]);
    });

    it('refuses a failing verdict line with no evidence naming D-15 (D-15)', async () => {
        const result = await call('checker', 'submitVerdict', {
            target_ref: chapter.id,
            criteria_passed: [{ criterion: 'C-3', result: false }],
            recommendation: 'fix',
            why: 'The change is not earned.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('D-15');
        expect(result.message).toBe(
            'Rule: D-15 — criteria_passed[0] fails C-3 with no evidence, and a verdict with no citable evidence is invalid.'
        );
    });

    it('writes a verdict and changes no story state (P6, D-1)', async () => {
        const result = await call('checker', 'submitVerdict', {
            target_ref: chapter.id,
            criteria_passed: [
                { criterion: 'C-3', result: true, evidence: 'chapter_1 section_1 changes his mind.' },
                { criterion: 'C-7', result: false, evidence: 'chapter_1 never climbs the tower.' }
            ],
            recommendation: 'fix',
            why: 'The contract is half delivered.'
        });

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            id: 'verdict_1',
            target_ref: 'chapter_1',
            target_kind: 'chapter',
            round: 1,
            hard_pass: false,
            failing_criteria: ['C-7'],
            state_changed: false,
            recommendation: 'fix'
        });
        expect(store.chapters.require(chapter.id).state).toBe('drafting');
        expect(store.verdicts.require('verdict_1').criteria_passed[1].finding_ref).toBeUndefined();
    });

    // ── §6.2a / D-21 / U-13: a verdict may name a competing DRAFT ────────────

    it('writes a verdict against one competing draft, and reads it back as a `revision` target (§6.2a, D-21, U-13)', async () => {
        seedRevision(store, story.id, chapter.id, 'The bell rings under the water.');

        const result = await call('checker', 'submitVerdict', {
            target_ref: 'revision_1',
            criteria_passed: [
                { criterion: 'C-3', result: true, evidence: 'revision_1 section_1 climbs the tower.' },
                { criterion: 'C-7', result: false, evidence: 'revision_1 never pays the bell off.' }
            ],
            recommendation: 'fix',
            why: 'The draft is one beat short.'
        });

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            id: 'verdict_1',
            target_ref: 'revision_1',
            // §4.9 → §4.4 vocabulary: the collection the ref resolved to becomes the target kind, so
            // U-13's pane can tell a draft verdict from the unit's (story-contract.ts:draftVerdicts).
            target_kind: 'revision',
            round: 1,
            hard_pass: false,
            failing_criteria: ['C-7'],
            state_changed: false,
            recommendation: 'fix'
        });
        expect(store.verdicts.require('verdict_1')).toMatchObject({
            story_id: story.id,
            target_ref: 'revision_1',
            target_kind: 'revision'
        });
        // The draft is not an artifact the loop advances: filing against it changes no chapter state (D-1).
        expect(store.chapters.require(chapter.id).state).toBe('drafting');
    });

    it("appends the verdict to the draft's `verdict_refs` in the SAME commit, and keeps appending (§4.15, D-21)", async () => {
        // §4.15's `revisions` row carries `verdict_refs`, and the Editor's brief reads the judgement off
        // the draft (run/brief.ts:renderCompetingRevisions). A verdict that exists without its ref on the
        // draft is a row the pane can only find by re-scanning §4.9, so the tool writes both halves of
        // the decision in one commit — P1: the record and the record about it land together.
        seedRevision(store, story.id, chapter.id, 'The bell rings under the water.');

        const first = await call('checker', 'submitVerdict', {
            target_ref: 'revision_1',
            criteria_passed: [{ criterion: 'C-3', result: true, evidence: 'revision_1 section_1 climbs the tower.' }],
            recommendation: 'advance',
            why: 'The draft delivers the contract.'
        });

        expect(first.ok).toBe(true);
        expect(store.revisions.require('revision_1').verdict_refs).toEqual(['verdict_1']);

        // One commit, in the order the tool performed it: the verdict row, then the ref that points at it.
        expect(
            store.journal
                .filter((event) => event.commit_label === 'tool:submitVerdict')
                .map((event) => `${event.collection}:${event.op}:${event.id}`)
        ).toEqual(['verdicts:create:verdict_1', 'revisions:update:revision_1']);

        // Additive, never a replace: a second checker pass on the same draft grows the list in order, and
        // the draft's own fields are untouched (D-1: a verdict judges, it does not decide).
        const second = await call('checker', 'submitVerdict', {
            target_ref: 'revision_1',
            criteria_passed: [{ criterion: 'C-7', result: false, evidence: 'revision_1 never pays the bell off.' }],
            recommendation: 'fix',
            why: 'The beat is missing.'
        });

        expect(second.ok).toBe(true);

        const draft = store.revisions.require('revision_1');

        expect(draft.verdict_refs).toEqual(['verdict_1', 'verdict_2']);
        expect({ state: draft.state, selection_note: draft.selection_note ?? '' }).toEqual({
            state: 'competing',
            selection_note: ''
        });
    });

    it('writes nothing on a draft when the verdict is about an ARTIFACT — the append is target-scoped (§4.15)', async () => {
        seedRevision(store, story.id, chapter.id, 'The bell rings under the water.');

        const result = await call('checker', 'submitVerdict', {
            target_ref: chapter.id,
            criteria_passed: [{ criterion: 'C-3', result: true, evidence: 'chapter_1 section_1 climbs the tower.' }],
            recommendation: 'advance',
            why: 'The unit delivers the contract.'
        });

        expect(result.ok).toBe(true);
        expect(store.revisions.require('revision_1').verdict_refs).toEqual([]);
        // The §4.15 row is not touched at all: the unit verdict rides §4.9, matched by `target_ref`.
        expect(store.journal.filter((event) => event.commit_label === 'tool:submitVerdict')).toHaveLength(1);
    });

    it('still refuses a FINDING aimed at a draft — a defect is a claim about the artifact (D-22, D-11)', async () => {
        seedRevision(store, story.id, chapter.id, 'The bell rings under the water.');

        const result = await call('checker', 'raiseFinding', {
            target_ref: 'revision_1',
            criterion_ref: 'C-3',
            title: 'A defect aimed at a draft',
            evidence: 'revision_1 section_1',
            cost: 'major',
            why: 'Triage.'
        });

        // D-22 deletes every losing draft in the selection commit, so a finding pointing at one would be
        // a claim about a row that no longer exists: `raiseFinding` keeps the narrow target set, and the
        // refusal names the kind it saw (T-11) rather than pretending the draft does not exist.
        expect(result.ok).toBe(false);
        expect(result).toEqual({
            ok: false,
            refused: 'T-11',
            error: 'Rule: T-11 — "revision_1" is a revision, not a story or summary or plotline or chapter, so the rule cannot apply to it',
            message:
                'Rule: T-11 — "revision_1" is a revision, not a story or summary or plotline or chapter, so the rule cannot apply to it',
            ref: 'revision_1',
            kind: 'revisions',
            expected_kinds: ['stories', 'summaries', 'plotlines', 'chapters'],
            fix: 'read stories or summaries or plotlines or chapters first and pass one of those'
        });
    });

    // ── D-37: the research tools run offline unless a fetch is injected ────

    it('reports a missing provider as a thinner Idea rather than a rule (D-37, T-12)', async () => {
        const result = await call('reader', 'searchWeb', { query: 'lighthouse reliefs 1880' });

        expect(result).toEqual({
            ok: false,
            error: 'searchWeb: no web provider is configured, so this process cannot reach the web.',
            message:
                'No EXA_API_KEY or TAVILY_API_KEY is set, so browsing is unavailable. That is a thinner Idea, not a story defect: form the Idea from the records you can read, or call reportGap if the brief really needs a lookup (T-12).',
            provider_missing: true,
            env_keys: ['EXA_API_KEY', 'TAVILY_API_KEY']
        });
    });

    it('uses the injected fetch for a search when a key is present (D-37)', async () => {
        process.env.EXA_API_KEY = 'test-key';
        const calls: Array<{ url: string; body: unknown }> = [];
        const runtime = createToolRuntime(store, {
            fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
                calls.push({ url: String(url), body: init ? JSON.parse(String(init.body)) : null });
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        results: [
                            {
                                title: 'Relief work',
                                url: 'https://example.org/relief',
                                text: 'Oil relief in 1880.',
                                score: 0.9
                            }
                        ]
                    })
                };
            }) as unknown as typeof fetch
        });
        const context = runtime.createContext(sessionFor(story.id, 'reader'));

        const result = await runtime.execute(context, 'searchWeb', { query: 'lighthouse oil relief 1880' });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            query: 'lighthouse oil relief 1880',
            provider: 'exa',
            results: [
                {
                    title: 'Relief work',
                    url: 'https://example.org/relief',
                    snippet: 'Oil relief in 1880.',
                    published_at: '',
                    score: 0.9
                }
            ],
            total: 1,
            untrusted: true
        });
        expect(calls).toEqual([
            {
                url: 'https://api.exa.ai/search',
                body: { query: 'lighthouse oil relief 1880', numResults: 5, type: 'auto', text: true }
            }
        ]);
    });

    it('refuses a malformed url naming T-11 rather than fetching it (T-11)', async () => {
        const result = await call('reader', 'fetchPage', { url: 'example.org/relief' });

        expect(result).toMatchObject({ ok: false, refused: 'T-11', field: 'url', received: 'example.org/relief' });
    });

    // ── P8 / D-2a: the story-state guards the row cannot express ───────────

    it('refuses a write on a stopped Story naming P8 while reads stay open (P8)', async () => {
        store.stories.update(
            story.id,
            { status: 'stopped', author_stop: true, status_reason: 'the Author paused it' },
            { why: 'seed: stop' }
        );

        const write = await call('writer', 'editChapter', {
            chapter_id: chapter.id,
            section_id: WRITER_SECTION.id,
            content: 'Written during a pause.',
            expects: [{ id: chapter.id, rev: chapter.rev }],
            why: 'Trying anyway.'
        });
        const read = await call('writer', 'readSeed', {});

        expect(write).toMatchObject({ ok: false, refused: 'P8', status: 'stopped', author_stop: true });
        expect(read.ok).toBe(true);
    });

    it('refuses a write on a completed Story naming D-2a (D-2a)', async () => {
        store.stories.update(story.id, { status: 'completed' }, { why: 'seed: complete' });

        const result = await call('writer', 'editChapter', {
            chapter_id: chapter.id,
            section_id: WRITER_SECTION.id,
            content: 'Written after completion.',
            expects: [{ id: chapter.id, rev: chapter.rev }],
            why: 'Trying anyway.'
        });

        expect(result).toMatchObject({ ok: false, refused: 'D-2a', status: 'completed' });
    });

    // ── D-22: the selection is one commit, and the losers are gone ─────────

    it('installs one draft and hard-deletes every loser inside a single commit (D-22, T-2a)', async () => {
        seedRevision(store, story.id, chapter.id, 'The map paid off on the page.');
        seedRevision(store, story.id, chapter.id, 'The bell under the water.');

        const result = await call('editor', 'selectRevision', {
            unit_ref: chapter.id,
            revision_id: 'revision_2',
            selection_note: 'It keeps the bell under the water.',
            expects: [{ id: chapter.id, rev: chapter.rev }]
        });

        // The whole result, exactly: the winner, the drafts that died with it, the post-install rev
        // of the unit (T-8), and the note the Author reads (L-17).
        expect(result).toEqual({
            ok: true,
            data: {
                id: 'revision_2',
                unit_ref: 'chapter_1',
                unit_kind: 'chapter',
                deleted_drafts: ['revision_1'],
                installed_rev: 2,
                selection_note: 'It keeps the bell under the water.',
                next: 'A fresh Writer now sees exactly one text for chapter_1; a checker run judges it and reports with submitVerdict.'
            },
            // T-8: the rev the call READ for the winner, which is what a follow-up `expects` sends.
            rev: 1,
            summary: 'Selected revision_2 for chapter_1; 1 draft deleted'
        });

        // D-22: the loser is deleted, not parked in another state — the next Writer cannot inherit
        // two texts, which is the whole reason the selection is one commit.
        expect(store.revisions.list().map((row) => row.id)).toEqual(['revision_2']);
        expect(store.revisions.get('revision_1')).toBeUndefined();
        expect(store.revisions.require('revision_2').state).toBe('selected');

        // The install itself, and D-24's trail: the unit records which draft it now holds.
        const installed = store.chapters.require('chapter_1');
        expect(installed.current_revision).toBe('revision_2');
        // D-7: the text lives in `sections`; the draft's body is what replaces them.
        expect(installed.sections.map((section) => section.text)).toEqual(['The bell under the water.']);
        expect(installed.rev).toBe(2);

        // ONE commit, one label (D-22 + D-12a): install, mark-selected and delete are one decision
        // in the journal, in the order the tool performed them.
        expect(
            store.journal
                .filter((event) => event.commit_label === 'tool:selectRevision')
                .map((event) => `${event.collection}:${event.op}:${event.id}`)
        ).toEqual(['chapters:update:chapter_1', 'revisions:update:revision_2', 'revisions:delete:revision_1']);
    });

    it('stores the selection note verbatim, including the dissent the run layer appends (D-38, U-8d, T-2a)', async () => {
        seedRevision(store, story.id, chapter.id, 'The map paid off on the page.');
        seedRevision(store, story.id, chapter.id, 'The bell under the water.');

        const result = await call('editor', 'selectRevision', {
            unit_ref: chapter.id,
            revision_id: 'revision_2',
            // The run executor composes this: the agent's own sentence, then `' | '`, then the
            // panel's split (`withDissent`/`dissentSentence` in src/server/run/panel.ts).
            selection_note: DISSENT_NOTE,
            expects: [{ id: chapter.id, rev: chapter.rev }]
        });

        // Appended dissent is ALLOWED, and nothing truncates or rewrites it: it is part of the
        // Author's record of how the choice was made, so it survives to the row and the journal.
        expect((result.data as Record<string, unknown>).selection_note).toBe(DISSENT_NOTE);
        expect(store.revisions.require('revision_2').selection_note).toBe(DISSENT_NOTE);
        expect(
            store.journal.find(
                (event) => event.commit_label === 'tool:selectRevision' && event.collection === 'revisions'
            )?.patch
        ).toEqual({ state: 'selected', selection_note: DISSENT_NOTE });
        // P11/T-5: the doubled-up note is still the write's reason, verbatim, on the audit row.
        expect(
            store.journal
                .filter((event) => event.commit_label === 'tool:selectRevision')
                .map((event) => event.attribution.why)
        ).toEqual([DISSENT_NOTE, DISSENT_NOTE, DISSENT_NOTE]);
    });

    it('refuses a selection whose own note is blank even though the panel may append to it (T-5, T-2a)', async () => {
        seedRevision(store, story.id, chapter.id, 'The map paid off on the page.');
        seedRevision(store, story.id, chapter.id, 'The bell under the water.');

        const result = await call('editor', 'selectRevision', {
            unit_ref: chapter.id,
            revision_id: 'revision_2',
            selection_note: '   ',
            expects: [{ id: chapter.id, rev: chapter.rev }]
        });

        // The append is additive, never a substitute: a caller that names no rule is refused, and
        // the refusal names the field the reason actually rides in (§8.2 has no `why` here).
        expect(result).toEqual({
            ok: false,
            refused: 'T-5',
            message: 'Rule: T-5 — selectRevision is a write, so it must carry why — every write records its reason',
            error: 'Rule: T-5 — selectRevision is a write, so it must carry why — every write records its reason',
            tool: 'selectRevision',
            field: 'selection_note',
            note: 'this tool carries the reason in selection_note',
            fix: 're-send with a one-line why, then the write will be attributed (P11)'
        });
        // Nothing moved: a refused selection leaves both drafts competing (D-21's inbox intact).
        expect(store.revisions.list().map((row) => row.state)).toEqual(['competing', 'competing']);
        expect(store.chapters.require('chapter_1').rev).toBe(1);
    });

    // ── L-11a: `related_refs` carries a finding across chapters ───────────

    it('stores related_refs on the finding so one report propagates across chapters (L-11a)', async () => {
        const result = await call('checker', 'raiseFinding', {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_1 section_2: "he already knew"',
            cost: 'major',
            // Out of order, doubled, blank and padded — the tool normalises, it does not guess.
            related_refs: ['chapter_3', ' chapter_2 ', '', 'chapter_3', 'plotline_1'],
            why: 'It spoils the middle of the book.'
        });

        expect((result.data as Record<string, unknown>).related_refs).toEqual(['chapter_3', 'chapter_2', 'plotline_1']);
        expect(store.findings.require('finding_1').related_refs).toEqual(['chapter_3', 'chapter_2', 'plotline_1']);
    });

    it('leaves related_refs off the record when the reporter names none (L-11a, §8 call shape)', async () => {
        const result = await call('checker', 'raiseFinding', {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_1 section_2: "he already knew"',
            cost: 'major',
            why: 'It spoils the middle of the book.'
        });

        // §8's row is unchanged: an omitted arg answers `[]`, and the record carries no empty array
        // that a later reader would have to distinguish from "there are none".
        expect((result.data as Record<string, unknown>).related_refs).toEqual([]);
        expect('related_refs' in store.findings.require('finding_1')).toBe(false);
    });

    it('merges new related_refs into the open row on a deduped repeat (L-11a, D-16)', async () => {
        const args = {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_1 section_2: "he already knew"',
            cost: 'major',
            related_refs: ['chapter_2'],
            why: 'It spoils the middle of the book.'
        };
        const first = await call('checker', 'raiseFinding', args);
        // The same defect, seen from another chapter: the fingerprint matches (D-16), so the row is
        // reused — and the new unit has to ride along or the propagation dies at the dedupe.
        const second = await call('checker', 'raiseFinding', { ...args, related_refs: ['chapter_7', 'chapter_2'] });

        expect(second).toMatchObject({ ok: true, repeat: true, finding_id: 'finding_1' });
        expect(store.findings.list().length).toBe(1);
        expect((second.data as Record<string, unknown>).related_refs).toEqual(['chapter_2', 'chapter_7']);
        expect(store.findings.require('finding_1').related_refs).toEqual(['chapter_2', 'chapter_7']);
        expect(store.findings.require('finding_1').seen_count).toBe(2);
    });

    it('journals only the seen_count bump when a repeat adds no refs (D-16)', async () => {
        const args = {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_1 section_2: "he already knew"',
            cost: 'major',
            why: 'It spoils the middle of the book.'
        };
        await call('checker', 'raiseFinding', args);
        const second = await call('checker', 'raiseFinding', args);

        // An identical repeat writes exactly one field: the digest derives from commits, so a
        // repeat that rewrote unrelated fields would look like a change (D-12a). The create event
        // of the first sighting is filtered out — this asserts on the dedupe's own write.
        expect((second.data as Record<string, unknown>).related_refs).toEqual([]);
        expect(
            store.journal
                .filter((event) => event.commit_label === 'tool:raiseFinding' && event.op === 'update')
                .map((event) => event.patch)
        ).toEqual([{ seen_count: 2 }]);
    });

    it('refuses a non-string related_refs item naming the index (T-11)', async () => {
        const result = await call('checker', 'raiseFinding', {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_1 section_2: "he already knew"',
            cost: 'major',
            related_refs: ['chapter_2', 7],
            why: 'It spoils the middle of the book.'
        });

        expect(result).toMatchObject({ ok: false, refused: 'T-11' });
        expect(result.issues).toEqual([{ field: 'related_refs[1]', expected: 'string', received: 7 }]);
    });

    it('surfaces related_refs on readFindings so the propagation is readable (L-11a)', async () => {
        await call('checker', 'raiseFinding', {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_1 section_2: "he already knew"',
            cost: 'major',
            related_refs: ['chapter_3'],
            why: 'It spoils the middle of the book.'
        });

        const result = await call('checker', 'readFindings', {});
        const page = result.data as Record<string, unknown>;

        expect((page.items as Record<string, unknown>[])[0]).toEqual({
            id: 'finding_1',
            target_ref: 'chapter_1',
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            detail: '',
            evidence: 'chapter_1 section_2: "he already knew"',
            cost: 'major',
            state: 'unconfirmed',
            confirmed_by: '',
            approved_by: '',
            seen_count: 1,
            related_refs: ['chapter_3'],
            rev: 1
        });
    });
});

/**
 * The pinned T3↔T5 contract (the loop engine and the run layer's fake are written against it).
 *
 * `src/server/run/types.ts` mirrors this layer as `RunToolContext = unknown`, and
 * `MockRunContext` in `src/server/run/mock.ts` is the concrete shape both sides read: the six flat
 * fields plus `services.delegate`. The compile-time assignment below is the guard — if the tool
 * layer renames or retypes one of them, this file stops compiling — and the assertions pin the
 * values at runtime so a rename cannot hide behind a permissive `unknown`.
 */
describe('the pinned tool-runtime contract', () => {
    /** The result shape the loop engine mirrors (`ToolResult` in `src/server/run/types.ts`). */
    type PinnedToolResult = {
        ok: boolean;
        data?: unknown;
        rev?: number;
        refused?: string;
        message?: string;
        cas_conflict?: boolean;
        currents?: { id: string; record: unknown }[];
        repeat?: boolean;
        finding_id?: string;
    };

    /** The context shape the run layer and the loop engine read (see `MockRunContext`). */
    type PinnedRunToolContext = {
        storyId: string;
        runRef: string;
        templateRef: string;
        roleName: string;
        roleKind: 'writer' | 'editor' | 'reader' | 'checker';
        services: {
            delegate?: (roleName: string, task: string) => Promise<{ ok: boolean; summary?: string; error?: string }>;
        };
    };

    /** The runtime contract: schemas for every session, one context per session, one execute. */
    interface PinnedToolRuntime {
        schemas(): ToolSchema[];
        createContext(
            session: {
                storyId: string;
                runRef: string;
                templateRef: string;
                roleName: string;
                roleKind: 'writer' | 'editor' | 'reader' | 'checker';
            },
            hooks?: {
                delegate?: (
                    roleName: string,
                    task: string
                ) => Promise<{ ok: boolean; summary?: string; error?: string }>;
            }
        ): PinnedRunToolContext;
        execute(ctx: PinnedRunToolContext, name: string, args: object): Promise<PinnedToolResult>;
    }

    it('satisfies the pinned runtime interface at the type level (T-6a, T-3, D-17e)', async () => {
        const world = seedWorld();
        const runtime: ToolRuntime = createToolRuntime(world.store);
        // Compile-time proof that the exported runtime is the pinned one; the runtime assertions
        // below are what stop a rename hiding behind the run layer's permissive `unknown`.
        const pinned: PinnedToolRuntime = runtime;
        expect(typeof pinned.schemas).toBe('function');
        expect(typeof pinned.createContext).toBe('function');
        expect(typeof pinned.execute).toBe('function');
    });

    it('binds exactly the six pinned context fields a session carries (T-3, P11, D-17e)', async () => {
        const world = seedWorld();
        const runtime: ToolRuntime = createToolRuntime(world.store);
        const context = runtime.createContext({
            storyId: world.story.id,
            runRef: 'run_7',
            templateRef: 'noir',
            roleName: 'keeper_editor',
            roleKind: 'editor'
        });

        expect({
            storyId: context.storyId,
            runRef: context.runRef,
            templateRef: context.templateRef,
            roleName: context.roleName,
            roleKind: context.roleKind
        }).toEqual({
            storyId: world.story.id,
            runRef: 'run_7',
            templateRef: 'noir',
            roleName: 'keeper_editor',
            roleKind: 'editor'
        });
        // `services` carries ONE capability, and only when the run supplied the hook (D-17e).
        expect(Object.keys(context.services)).toEqual([]);
        expect(context.services.delegate).toBeUndefined();

        // T-0's degraded case keeps a usable row rather than an empty kind, because `execute` is
        // what refuses an unknown kind (naming T-0) — the context itself stays total.
        const unknownKind = runtime.createContext({
            storyId: world.story.id,
            runRef: 'run_8',
            templateRef: 'noir',
            roleName: '',
            roleKind: 'writter' as 'writer'
        });
        expect({ roleKind: unknownKind.roleKind, roleName: unknownKind.roleName, runRef: unknownKind.runRef }).toEqual({
            roleKind: 'writer',
            roleName: 'writer',
            runRef: 'run_8'
        });
    });

    it('narrows a delegate hook to the pinned ok/summary/error answer (D-17e, T-2b)', async () => {
        const world = seedWorld();
        const calls: { role: string; task: string }[] = [];
        const runtime: ToolRuntime = createToolRuntime(world.store);
        const context = runtime.createContext(
            { storyId: world.story.id, runRef: 'run_9', templateRef: 'noir', roleName: 'editor_1', roleKind: 'editor' },
            {
                // The run layer's hook may answer with a whole tool result; the context owes the
                // caller only the pinned three fields.
                delegate: async (role: string, task: string) => {
                    calls.push({ role, task });
                    return {
                        ok: true,
                        summary: 'The bell, not the map.',
                        data: { chapters: ['chapter_2'] },
                        refused: 'ignored-by-the-contract'
                    };
                }
            }
        );

        const answer = await context.services.delegate!('checker_2', 'Which draft pays the setup off?');

        expect(calls).toEqual([{ role: 'checker_2', task: 'Which draft pays the setup off?' }]);
        expect(answer).toEqual({ ok: true, summary: 'The bell, not the map.' });
    });
});
