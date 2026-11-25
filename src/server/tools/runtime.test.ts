/**
 * W2 acceptance for the tool pipeline (§8, §12 W2).
 *
 * Every assertion is an exact value: the rule id a refusal carries, the row it came from, the
 * record a write produced, and the journal entry behind it. The §12 W2 sentence names four
 * refusals by rule (a Critic's prose write as P10, an Editor's prose write as L-19, a locked
 * Summary as P5, a cross-Story ref as T-3) — those are pinned first, then the pipeline rules the
 * spec pins (T-4, T-5, T-6a, T-6c, T-8, T-11, T-12) and the behaviour rules (§7, D-1, D-12a,
 * D-15, D-16, D-26/D-32, D-31, P9, D-37).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import { seedHashOf } from '../../shared/seed-hash';
import type { Chapter, ChapterSection, Revision, RoleKind, SeedBrief, Story, StoryPhase } from '../../shared/types';
import type { ToolSchema } from '../llm/client';
// The loop's own D-51 readings, imported here so these rows pin that the tool payload and the drain
// gate agree on what counts as a waiver (T10/F1).
import { researchGate, researchWaived } from '../loop/records';
import { createToolRuntime, type RunToolContext, type ToolResult, type ToolRuntime } from './index';
// D-33b: the fingerprint pair the legacy back-compat pin needs — the pre-`kind` three-part form built
// from the same exported primitives, so the test states the OLD value instead of trusting the new
// helper to agree with itself.
import { fingerprintFinding } from './artifacts';
import { computeFingerprint, normalizeForFingerprint } from './utilities';
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
 * draft a test creates is `revision_0` and the next is `revision_1` — the D-22 tests below name
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
    'It keeps the bell under the water. | 2 of 3 preferred revision_0; selected revision_1 on the must_happen rule';

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

    it('refuses a Critic finding with no detail, so the Editor gets the what-and-where line (D-30)', async () => {
        const result = await call('critic', 'raiseFinding', {
            target_ref: chapter.id,
            criterion_ref: 'C-7',
            title: 'the contract is not delivered',
            evidence: 'the prose skips the climb',
            cost: 'major',
            why: 'the Critic angle found it'
        });

        expect(result).toMatchObject({
            ok: false,
            refused: 'D-30',
            message: expect.stringContaining('detail')
        });
        // No row was written: the refusal is before the create, not a silent blank field.
        expect(store.findings.list()).toEqual([]);
    });

    it("refuses a Critic's prose write naming P10, and names the row it came from", async () => {
        const result = await call('critic', 'editChapter', {
            chapter_id: chapter.id,
            section_id: WRITER_SECTION.id,
            content: 'A critic tried to write prose.',
            expects: [{ id: chapter.id, rev: chapter.rev }],
            why: 'Because the brief said to.'
        });

        expect(result).toEqual({
            ok: false,
            refused: 'P10',
            message:
                'Rule: P10 — a critic may not editChapter on chapters.content (agent-written): §7 gives a critic "read" there. Route the job to a writer',
            error: 'Rule: P10 — a critic may not editChapter on chapters.content (agent-written): §7 gives a critic "read" there. Route the job to a writer',
            story_id: story.id,
            artifact: 'chapters.content (agent-written)',
            role: 'critic',
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
            expects: [{ id: 'summary_0', rev: 1 }],
            why: 'The premise reads thin.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('P5');
        expect(result.message).toBe(
            'Rule: P5 — the Summary is locked (`summary_locked` is true), so it is read-only for every agent'
        );
        expect(result.field).toBe('summary_locked');
        expect(store.summaries.require('summary_0').premise).toBe('A keeper, a light, a debt.');
    });

    it('refuses a write outside phase `summary` naming T-3c, when the lock is not the blocker', async () => {
        const result = await call('writer', 'editSummary', {
            premise: 'Rewritten in the wrong phase.',
            expects: [{ id: 'summary_0', rev: 1 }],
            why: 'Trying anyway.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('T-3c');
        expect(result.phase).toBe('chapters');
    });

    it('files a Summary draft as pending and keeps ONE row while its Writer extends it (§4.15)', async () => {
        // A Story that assigns a diverging Writer template files Summary writes as competing drafts
        // (`isDivergenceMode`). The row starts `pending`: the Writer may take several calls to fill
        // the six §4.2 blocks, and a second call in the same run must extend the same draft, not
        // file a second partial one.
        store.stories.update(
            story.id,
            { phase: 'summary', template_refs: ['diverging'] },
            { why: 'seed: phase ① with a diverging Writer template' }
        );
        store.templates.create(
            {
                name: 'diverging',
                title: 'Diverging Writer',
                roles: [{ name: 'writer', kind: 'writer', prompt: 'write the Summary' }],
                serves_phase: ['summary'],
                done_definition: 'the Summary carries its blocks',
                attempts: 2,
                builtin: false,
                editable: true
            },
            { why: 'seed: diverging writer template' }
        );

        const first = await call('writer', 'editSummary', {
            premise: 'The lamp logs its own keepers.',
            expects: [{ id: 'summary_0', rev: 1 }],
            why: 'the first block'
        });

        expect(first.ok).toBe(true);

        const revisionId = String((first as { revision_id?: string }).revision_id);

        expect(store.revisions.list()).toHaveLength(1);
        expect(store.revisions.require(revisionId).state).toBe('pending');

        const second = await call('writer', 'editSummary', {
            tone: 'close third person, tidal',
            expects: [{ id: 'summary_0', rev: 1 }],
            why: 'the tone block'
        });

        expect(second.ok).toBe(true);

        // Still one draft: the second call extended the pending row instead of filing another.
        const rows = store.revisions.list();

        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(revisionId);
        expect(rows[0].state).toBe('pending');
        // The draft carries the blocks written so far; the installed Summary's fields are inherited
        // where the Writer has not spoken, and the Writer's own text wins where it has.
        expect((rows[0].body as { fields: Record<string, unknown> }).fields).toMatchObject({
            premise: 'The lamp logs its own keepers.',
            tone: 'close third person, tidal'
        });
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
            id: 'chapter_0',
            order: 1,
            title: 'Sign off',
            section_id: 'section_1',
            // D-7: the write lands in `sections` (the derived `content` is never a field).
            fields_written: ['sections'],
            // The count is the whole chapter's — `content` is the join over sections (D-7).
            word_count: 9,
            section_count: 2,
            current_rev: 2,
            next: 'Keep working the queue — a reader run judges this chapter and reports with submitVerdict.'
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
        const result = await call('reader', 'readChapter', { chapter_id: chapter.id });

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
        // §8.1 (8) + §8.2 (10) + §8.3 (6) + §8.4 (17) + §8.5 (4) + the Phase-1 research surface
        // (4). Every session holds all of them whatever its kind (T-6a), so the count is itself a
        // conformance number.
        expect(result.catalogue_size).toBe(53);
    });

    it('refuses an unknown role kind naming T-0 rather than defaulting it (T-0)', async () => {
        const result = await call('writter', 'readSeed', {});

        expect(result).toMatchObject({
            ok: false,
            refused: 'T-0',
            role_kind: 'writter',
            // §7.2's five dispatched kinds — the Researcher is a session kind like the rest.
            expected_kinds: ['writer', 'editor', 'critic', 'reader', 'researcher']
        });
    });

    // ── §7 rows the engine cannot express as a level ────────────────────────

    it('refuses updateDigest for every role naming D-12a, and names the digest_gap fix (D-12a, D-13)', async () => {
        for (const role of ['writer', 'editor', 'reader', 'critic']) {
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
        const result = await call('reader', 'markChapterDone', { chapter_id: chapter.id });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            chapter_id: 'chapter_0',
            chapter_state: 'drafting',
            task_id: 'task_0',
            open_findings: 0,
            state_changed: false
        });
        expect(store.chapters.require(chapter.id).state).toBe('drafting');
        expect(store.tasks.require('task_0')).toMatchObject({
            kind: 'signoff',
            title: 'Sign off chapter 1: Sign off',
            owner_role: 'author',
            state: 'open',
            priority: 45
        });
    });

    it('files a capability_gap task on reportGap and writes no artifact (T-12)', async () => {
        const before = store.journal.length;
        const result = await call('critic', 'reportGap', {
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
            task_id: 'task_0',
            owner_role: 'author'
        });
        expect(store.tasks.require('task_0')).toMatchObject({
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
        const first = await call('critic', 'reportGap', args);
        const second = await call('critic', 'reportGap', args);

        expect(first.repeat).toBeUndefined();
        expect(second).toMatchObject({ ok: true, repeat: true, task_id: 'task_0' });
        expect(store.tasks.list().length).toBe(1);
    });

    it('refuses a reader verifying an Idea naming P10 — verification is the Editor row (D-31)', async () => {
        const idea = store.ideas.create(
            {
                story_id: story.id,
                phase: 'chapters',
                body: 'The keeper should not survive chapter 1.',
                kind: 'possibility',
                author: 'critic_1',
                sources: [],
                fingerprint: 'fp_test',
                seen_count: 1,
                state: 'proposed'
            },
            { why: 'seed: idea' }
        );

        const result = await call('reader', 'verifyIdea', {
            idea_id: idea.id,
            verdict: 'verified',
            evidence: 'Checked against the Summary promise.',
            meets_guidelines: true,
            why: 'It holds up.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('P10');
        expect(result.message).toBe(
            'Rule: P10 — a reader may not verifyIdea on ideas: §7 gives a reader "write" there. Route the job to an editor'
        );
    });

    it('dedupes a repeated finding by bumping seen_count instead of a second row (D-16)', async () => {
        const args = {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_0 section_2: "he already knew"',
            cost: 'major',
            why: 'It breaks the promise of the first chapter.'
        };
        const first = await call('reader', 'raiseFinding', args);
        const second = await call('reader', 'raiseFinding', args);

        expect(first.data).toMatchObject({ id: 'finding_0', state: 'unconfirmed', seen_count: 1, cost: 'major' });
        expect(second).toMatchObject({ ok: true, repeat: true, finding_id: 'finding_0' });
        expect(store.findings.list().length).toBe(1);
        expect(store.findings.require('finding_0').seen_count).toBe(2);
        expect(store.findings.require('finding_0').state).toBe('unconfirmed');
    });

    it('reports an already-decided Idea instead of re-opening it (D-32, D-26)', async () => {
        store.ideas.create(
            {
                story_id: story.id,
                phase: 'chapters',
                body: 'The light should fail on page one.',
                kind: 'direction',
                author: 'critic_1',
                sources: [],
                fingerprint: 'fp_decided',
                seen_count: 1,
                state: 'discarded',
                selection_note: 'It removes the whole tension.'
            },
            { why: 'seed: decided idea' }
        );

        const result = await call('critic', 'proposeIdea', {
            phase: 'chapters',
            body: 'The light should fail on page one.',
            kind: 'direction',
            sources: [],
            why: 'It would sharpen the opening.'
        });

        expect(result).toMatchObject({ ok: true, repeat: true, idea_id: 'idea_0' });
        expect((result.notes as string[])[0]).toContain('Rule D-32');
        expect(store.ideas.list().length).toBe(1);
        expect(store.ideas.require('idea_0').state).toBe('discarded');
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
        expect(result.summary).toBe('Chapter 1 change filed as proposal proposal_0 (P9)');
        expect(result.data).toEqual({
            proposal_id: 'proposal_0',
            id: 'chapter_0',
            target_ref: 'chapter_0',
            target_field: 'sections',
            state: 'pending',
            proposed: true,
            locked_sections: ['section_2'],
            // Nothing was written, so the rev the call reports is still the one it read (T-8).
            current_rev: 1
        });
        expect(store.chapters.require(chapter.id).sections).toEqual([WRITER_SECTION, AUTHOR_SECTION]);
        expect(store.proposals.require('proposal_0')).toMatchObject({
            target_ref: 'chapter_0',
            target_field: 'sections',
            state: 'pending'
        });
    });

    // ── T-11 and D-15: validation inside the tool ───────────────────────────

    it('refuses a raiseFinding with no cost, naming the enum set (T-11)', async () => {
        const result = await call('reader', 'raiseFinding', {
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
        const result = await call('reader', 'submitVerdict', {
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
        const result = await call('reader', 'submitVerdict', {
            target_ref: chapter.id,
            criteria_passed: [
                { criterion: 'C-3', result: true, evidence: 'chapter_0 section_1 changes his mind.' },
                { criterion: 'C-7', result: false, evidence: 'chapter_0 never climbs the tower.' }
            ],
            recommendation: 'fix',
            why: 'The contract is half delivered.'
        });

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            id: 'verdict_0',
            target_ref: 'chapter_0',
            target_kind: 'chapter',
            round: 1,
            hard_pass: false,
            failing_criteria: ['C-7'],
            state_changed: false,
            recommendation: 'fix'
        });
        expect(store.chapters.require(chapter.id).state).toBe('drafting');
        expect(store.verdicts.require('verdict_0').criteria_passed[1].finding_ref).toBeUndefined();
    });

    // ── §6.2a / D-21 / U-13: a verdict may name a competing DRAFT ────────────

    it('writes a verdict against one competing draft, and reads it back as a `revision` target (§6.2a, D-21, U-13)', async () => {
        seedRevision(store, story.id, chapter.id, 'The bell rings under the water.');

        const result = await call('reader', 'submitVerdict', {
            target_ref: 'revision_0',
            criteria_passed: [
                { criterion: 'C-3', result: true, evidence: 'revision_0 section_1 climbs the tower.' },
                { criterion: 'C-7', result: false, evidence: 'revision_0 never pays the bell off.' }
            ],
            recommendation: 'fix',
            why: 'The draft is one beat short.'
        });

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            id: 'verdict_0',
            target_ref: 'revision_0',
            // §4.9 → §4.4 vocabulary: the collection the ref resolved to becomes the target kind, so
            // U-13's pane can tell a draft verdict from the unit's (story-contract.ts:draftVerdicts).
            target_kind: 'revision',
            round: 1,
            hard_pass: false,
            failing_criteria: ['C-7'],
            state_changed: false,
            recommendation: 'fix'
        });
        expect(store.verdicts.require('verdict_0')).toMatchObject({
            story_id: story.id,
            target_ref: 'revision_0',
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

        const first = await call('reader', 'submitVerdict', {
            target_ref: 'revision_0',
            criteria_passed: [{ criterion: 'C-3', result: true, evidence: 'revision_0 section_1 climbs the tower.' }],
            recommendation: 'advance',
            why: 'The draft delivers the contract.'
        });

        expect(first.ok).toBe(true);
        expect(store.revisions.require('revision_0').verdict_refs).toEqual(['verdict_0']);

        // One commit, in the order the tool performed it: the verdict row, then the ref that points at it.
        expect(
            store.journal
                .filter((event) => event.commit_label === 'tool:submitVerdict')
                .map((event) => `${event.collection}:${event.op}:${event.id}`)
        ).toEqual(['verdicts:create:verdict_0', 'revisions:update:revision_0']);

        // Additive, never a replace: a second reader pass on the same draft grows the list in order, and
        // the draft's own fields are untouched (D-1: a verdict judges, it does not decide).
        const second = await call('reader', 'submitVerdict', {
            target_ref: 'revision_0',
            criteria_passed: [{ criterion: 'C-7', result: false, evidence: 'revision_0 never pays the bell off.' }],
            recommendation: 'fix',
            why: 'The beat is missing.'
        });

        expect(second.ok).toBe(true);

        const draft = store.revisions.require('revision_0');

        expect(draft.verdict_refs).toEqual(['verdict_0', 'verdict_1']);
        expect({ state: draft.state, selection_note: draft.selection_note ?? '' }).toEqual({
            state: 'competing',
            selection_note: ''
        });
    });

    it('writes nothing on a draft when the verdict is about an ARTIFACT — the append is target-scoped (§4.15)', async () => {
        seedRevision(store, story.id, chapter.id, 'The bell rings under the water.');

        const result = await call('reader', 'submitVerdict', {
            target_ref: chapter.id,
            criteria_passed: [{ criterion: 'C-3', result: true, evidence: 'chapter_0 section_1 climbs the tower.' }],
            recommendation: 'advance',
            why: 'The unit delivers the contract.'
        });

        expect(result.ok).toBe(true);
        expect(store.revisions.require('revision_0').verdict_refs).toEqual([]);
        // The §4.15 row is not touched at all: the unit verdict rides §4.9, matched by `target_ref`.
        expect(store.journal.filter((event) => event.commit_label === 'tool:submitVerdict')).toHaveLength(1);
    });

    it('still refuses a FINDING aimed at a draft — a defect is a claim about the artifact (D-22, D-11)', async () => {
        seedRevision(store, story.id, chapter.id, 'The bell rings under the water.');

        const result = await call('reader', 'raiseFinding', {
            target_ref: 'revision_0',
            criterion_ref: 'C-3',
            title: 'A defect aimed at a draft',
            evidence: 'revision_0 section_1',
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
            error: 'Rule: T-11 — "revision_0" is a revision, not a story or summary or plotline or chapter, so the rule cannot apply to it',
            message:
                'Rule: T-11 — "revision_0" is a revision, not a story or summary or plotline or chapter, so the rule cannot apply to it',
            ref: 'revision_0',
            kind: 'revisions',
            expected_kinds: ['stories', 'summaries', 'plotlines', 'chapters'],
            fix: 'read stories or summaries or plotlines or chapters first and pass one of those'
        });
    });

    // ── D-37: the research tools run offline unless a fetch is injected ────

    it('reports a missing provider as a thinner Idea rather than a rule (D-37, T-12)', async () => {
        const result = await call('critic', 'searchWeb', { query: 'lighthouse reliefs 1880' });

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
        const context = runtime.createContext(sessionFor(story.id, 'critic'));

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
        const result = await call('critic', 'fetchPage', { url: 'example.org/relief' });

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
            revision_id: 'revision_1',
            selection_note: 'It keeps the bell under the water.',
            expects: [{ id: chapter.id, rev: chapter.rev }]
        });

        // The whole result, exactly: the winner, the drafts that died with it, the post-install rev
        // of the unit (T-8), and the note the Author reads (L-17).
        expect(result).toEqual({
            ok: true,
            data: {
                id: 'revision_1',
                unit_ref: 'chapter_0',
                unit_kind: 'chapter',
                deleted_drafts: ['revision_0'],
                installed_rev: 2,
                selection_note: 'It keeps the bell under the water.',
                next: 'A fresh Writer now sees exactly one text for chapter_0; a reader run judges it and reports with submitVerdict.'
            },
            // T-8: the rev the call READ for the winner, which is what a follow-up `expects` sends.
            rev: 1,
            summary: 'Selected revision_1 for chapter_0; 1 draft deleted'
        });

        // D-22: the loser is deleted, not parked in another state — the next Writer cannot inherit
        // two texts, which is the whole reason the selection is one commit.
        expect(store.revisions.list().map((row) => row.id)).toEqual(['revision_1']);
        expect(store.revisions.get('revision_0')).toBeUndefined();
        expect(store.revisions.require('revision_1').state).toBe('selected');

        // The install itself, and D-24's trail: the unit records which draft it now holds.
        const installed = store.chapters.require('chapter_0');
        expect(installed.current_revision).toBe('revision_1');
        // D-7: the text lives in `sections`; the draft's body is what replaces them.
        expect(installed.sections.map((section) => section.text)).toEqual(['The bell under the water.']);
        expect(installed.rev).toBe(2);

        // ONE commit, one label (D-22 + D-12a): install, mark-selected and delete are one decision
        // in the journal, in the order the tool performed them.
        expect(
            store.journal
                .filter((event) => event.commit_label === 'tool:selectRevision')
                .map((event) => `${event.collection}:${event.op}:${event.id}`)
        ).toEqual(['chapters:update:chapter_0', 'revisions:update:revision_1', 'revisions:delete:revision_0']);
    });

    it('stores the selection note verbatim, including the dissent the run layer appends (D-38, U-8d, T-2a)', async () => {
        seedRevision(store, story.id, chapter.id, 'The map paid off on the page.');
        seedRevision(store, story.id, chapter.id, 'The bell under the water.');

        const result = await call('editor', 'selectRevision', {
            unit_ref: chapter.id,
            revision_id: 'revision_1',
            // The run executor composes this: the agent's own sentence, then `' | '`, then the
            // panel's split (`withDissent`/`dissentSentence` in src/server/run/panel.ts).
            selection_note: DISSENT_NOTE,
            expects: [{ id: chapter.id, rev: chapter.rev }]
        });

        // Appended dissent is ALLOWED, and nothing truncates or rewrites it: it is part of the
        // Author's record of how the choice was made, so it survives to the row and the journal.
        expect((result.data as Record<string, unknown>).selection_note).toBe(DISSENT_NOTE);
        expect(store.revisions.require('revision_1').selection_note).toBe(DISSENT_NOTE);
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
            revision_id: 'revision_1',
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
        expect(store.chapters.require('chapter_0').rev).toBe(1);
    });

    // ── L-11a: `related_refs` carries a finding across chapters ───────────

    it('stores related_refs on the finding so one report propagates across chapters (L-11a)', async () => {
        const result = await call('reader', 'raiseFinding', {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_0 section_2: "he already knew"',
            cost: 'major',
            // Out of order, doubled, blank and padded — the tool normalises, it does not guess.
            related_refs: ['chapter_2', ' chapter_1 ', '', 'chapter_2', 'plotline_0'],
            why: 'It spoils the middle of the book.'
        });

        expect((result.data as Record<string, unknown>).related_refs).toEqual(['chapter_2', 'chapter_1', 'plotline_0']);
        expect(store.findings.require('finding_0').related_refs).toEqual(['chapter_2', 'chapter_1', 'plotline_0']);
    });

    it('leaves related_refs off the record when the reporter names none (L-11a, §8 call shape)', async () => {
        const result = await call('reader', 'raiseFinding', {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_0 section_2: "he already knew"',
            cost: 'major',
            why: 'It spoils the middle of the book.'
        });

        // §8's row is unchanged: an omitted arg answers `[]`, and the record carries no empty array
        // that a later reader would have to distinguish from "there are none".
        expect((result.data as Record<string, unknown>).related_refs).toEqual([]);
        expect('related_refs' in store.findings.require('finding_0')).toBe(false);
    });

    it('merges new related_refs into the open row on a deduped repeat (L-11a, D-16)', async () => {
        const args = {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_0 section_2: "he already knew"',
            cost: 'major',
            related_refs: ['chapter_1'],
            why: 'It spoils the middle of the book.'
        };
        const first = await call('reader', 'raiseFinding', args);
        // The same defect, seen from another chapter: the fingerprint matches (D-16), so the row is
        // reused — and the new unit has to ride along or the propagation dies at the dedupe.
        const second = await call('reader', 'raiseFinding', { ...args, related_refs: ['chapter_6', 'chapter_1'] });

        expect(second).toMatchObject({ ok: true, repeat: true, finding_id: 'finding_0' });
        expect(store.findings.list().length).toBe(1);
        expect((second.data as Record<string, unknown>).related_refs).toEqual(['chapter_1', 'chapter_6']);
        expect(store.findings.require('finding_0').related_refs).toEqual(['chapter_1', 'chapter_6']);
        expect(store.findings.require('finding_0').seen_count).toBe(2);
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
        await call('reader', 'raiseFinding', args);
        const second = await call('reader', 'raiseFinding', args);

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
        const result = await call('reader', 'raiseFinding', {
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
        await call('reader', 'raiseFinding', {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            evidence: 'chapter_0 section_2: "he already knew"',
            cost: 'major',
            related_refs: ['chapter_2'],
            why: 'It spoils the middle of the book.'
        });

        const result = await call('reader', 'readFindings', {});
        const page = result.data as Record<string, unknown>;

        expect((page.items as Record<string, unknown>[])[0]).toEqual({
            id: 'finding_0',
            target_ref: 'chapter_0',
            criterion_ref: 'C-3',
            title: 'The keeper knows the answer too early',
            detail: '',
            evidence: 'chapter_0 section_2: "he already knew"',
            cost: 'major',
            // D-33b: the claim type, defaulted on the read — this raise named no `kind`.
            kind: 'issue',
            state: 'unconfirmed',
            confirmed_by: '',
            approved_by: '',
            seen_count: 1,
            related_refs: ['chapter_2'],
            rev: 1
        });
    });

    // ── §7.2's Researcher column (documents/phase-1-research-pipeline.md) ───────────────────

    /** The one citation §7.1/T-10 requires: the page, the claim it supports, when it was read. */
    const SOURCE = {
        url_or_title: 'The 1880 Service Revolver, ch. 2',
        claim: 'The pattern held six rounds and was loaded through a gate.',
        accessed_at: '2026-11-23T09:00:00.000Z'
    };

    /**
     * A well-formed `structureSeed` call for the Seed this fixture Story holds.
     *
     * D-51: `research_questions` is a required arg, so the fixture states a decision — here ONE
     * question, which keeps these rows on the pre-existing behaviour (the brief dispatches a
     * Researcher). The waiver rows below send `[]` explicitly.
     */
    const seedCall = () => ({
        seed_hash: seedHashOf(story.idea),
        logline: 'A keeper learns the light was never the point.',
        protagonist: 'The keeper',
        want: 'To keep the light burning',
        obstacle: 'The debt the light was built on',
        stakes: 'The harbour',
        setting: 'A rock in the North Sea, 1880',
        world_rules: ['No magic; the light is engineering.'],
        promise: 'The debt is paid by the last page.',
        constraints: ['No flashbacks after chapter 3.'],
        open_questions: [],
        research_questions: ['What could 1880 North Sea lighthouse engineering actually do?'],
        why: 'The Seed states every structural field this brief restates.'
    });

    it('lets a Researcher write knowledge, and refuses a Writer naming P10 (D-16, §7.2)', async () => {
        const written = await call('researcher', 'writeKnowledge', {
            topic: '1880 service revolver',
            kind: 'tech',
            claim: 'An 1880 service revolver holds six rounds.',
            detail: 'Loaded through a gate on the right side.',
            importance: 'critical',
            sources: [SOURCE],
            why: 'A chapter puts one in the keeper hands.'
        });

        expect(written.ok).toBe(true);
        expect(written.data).toEqual({
            knowledge_id: 'knowledge_entry_0',
            id: 'knowledge_entry_0',
            // The dedupe key is STORY-scoped (S-RUNTIME): `knowledgeFingerprint(storyId, topic, claim)`
            // is `k_` + FNV over `story_0|1880 service revolver|an 1880 service revolver holds six rounds`
            // (tools/knowledge.ts:74). Pinned because it is the row's identity, and derived by running that
            // function over this fixture's Story id (`story_0` — the counter id an unbound Store mints).
            fingerprint: 'k_46c87e11',
            topic: '1880 service revolver',
            importance: 'critical',
            reaches_sampling: true,
            kind: 'tech',
            sources: 1,
            current_rev: 1
        });
        expect(written.summary).toBe('Knowledge knowledge_entry_0 recorded (tech, critical)');

        // §7.2: only the Researcher writes `knowledge`; every other kind reads it. The refusal
        // names P10 and routes the job, exactly as a Reader's or a Critic's prose refusal does.
        const refused = await call('writer', 'writeKnowledge', {
            topic: '1880 service revolver',
            kind: 'tech',
            claim: 'An 1880 service revolver holds six rounds.',
            importance: 'critical',
            sources: [SOURCE],
            why: 'The Writer tries to write the book instead.'
        });

        expect({ ok: refused.ok, refused: refused.refused, message: refused.message }).toEqual({
            ok: false,
            refused: 'P10',
            message:
                'Rule: P10 — a writer may not writeKnowledge on knowledge: §7 gives a writer "read" there. Route the job to a researcher'
        });
    });

    it("refuses a Researcher's Summary write naming P10, so research never becomes prose (§7.2)", async () => {
        const refused = await call('researcher', 'editSummary', {
            premise: 'The researcher decides the book.',
            expects: [{ id: 'summary_0', rev: 1 }],
            why: 'It read a good source.'
        });

        expect({ ok: refused.ok, refused: refused.refused, message: refused.message }).toEqual({
            ok: false,
            refused: 'P10',
            message:
                'Rule: P10 — a researcher may not editSummary on summaries (prose): §7 gives a researcher "read" there. Route the job to a writer'
        });
        // Nothing was written: the refusal is the record (T-1a).
        expect(store.summaries.list()[0]?.premise).toBe('A keeper, a light, a debt.');
    });

    it('bumps seen_count and merges sources on a repeat, and takes the new importance (D-16)', async () => {
        const first = await call('researcher', 'writeKnowledge', {
            topic: '1880 service revolver',
            kind: 'tech',
            claim: 'An 1880 service revolver holds six rounds.',
            importance: 'normal',
            sources: [SOURCE],
            why: 'First sighting.'
        });

        expect(first.repeat).toBeUndefined();

        const second = await call('researcher', 'writeKnowledge', {
            topic: '1880 Service Revolver',
            kind: 'tech',
            claim: 'An 1880 service revolver holds six rounds.',
            importance: 'high',
            sources: [
                SOURCE,
                {
                    url_or_title: 'Board of Ordnance ledger, 1881',
                    claim: 'Six rounds were the service load.',
                    accessed_at: '2026-11-23T09:10:00.000Z'
                }
            ],
            why: 'A second source confirms the load and the entry matters more.'
        });

        // The fingerprint normalises case, so a re-capitalised topic is the same entry.
        expect({ repeat: second.repeat, data: second.data }).toEqual({
            repeat: true,
            data: {
                knowledge_id: 'knowledge_entry_0',
                id: 'knowledge_entry_0',
                // Same key as the first write: the topic's new capitalisation normalises away, and the
                // Story half of the key is unchanged, so the repeat carries the first row's fingerprint.
                fingerprint: 'k_46c87e11',
                topic: '1880 service revolver',
                importance: 'high',
                kind: 'tech',
                seen_count: 2,
                sources: [
                    SOURCE,
                    {
                        url_or_title: 'Board of Ordnance ledger, 1881',
                        claim: 'Six rounds were the service load.',
                        accessed_at: '2026-11-23T09:10:00.000Z'
                    }
                ],
                current_rev: 2
            }
        });
        expect(store.knowledge.list()).toHaveLength(1);
    });

    it('refuses a knowledge write with no citation, naming T-10 (T-10)', async () => {
        const refused = await call('researcher', 'writeKnowledge', {
            topic: 'the harbour freezes',
            kind: 'place',
            claim: 'The harbour freezes in January.',
            importance: 'high',
            sources: [],
            why: 'It decides the finale.'
        });

        expect({ ok: refused.ok, refused: refused.refused, message: refused.message }).toEqual({
            ok: false,
            refused: 'T-10',
            message:
                'Rule: T-10 — writeKnowledge needs at least one source: every knowledge entry names what it stands on'
        });
    });

    it('refuses a citation with a missing field at the schema first, naming the field (T-11, T-10)', async () => {
        const refused = await call('researcher', 'writeKnowledge', {
            topic: 'the harbour freezes',
            kind: 'place',
            claim: 'The harbour freezes in January.',
            importance: 'high',
            sources: [{ url_or_title: 'Almanac', claim: 'The harbour froze on 5 January 1881.' }],
            why: 'It decides the finale.'
        });

        // T-11's order: the body is validated before the tool body runs, so the missing field is
        // named with its path. (The tool's own T-10 guard is the second line of defence, reached
        // only if a caller bypasses the schema.)
        expect({ ok: refused.ok, refused: refused.refused, issues: refused.issues }).toEqual({
            ok: false,
            refused: 'T-11',
            issues: [{ field: 'sources[0].accessed_at', expected: 'string' }]
        });
    });

    it('lets every kind read knowledge, most load-bearing first (T-7, §7.2)', async () => {
        // The stored `topic` is the NORMALISED key (D-16's dedupe part), so the fixtures use
        // spellings that survive normalisation unchanged; the repeat test covers the normalising.
        for (const [topic, importance] of [
            ['the harbour freezes', 'normal'],
            ['six round revolver', 'critical'],
            ['the light is engineering', 'high']
        ] as const)
            await call('researcher', 'writeKnowledge', {
                topic,
                kind: 'fact',
                claim: `${topic} is true in this world.`,
                importance,
                sources: [SOURCE],
                why: 'Seed research.'
            });

        for (const kind of ['writer', 'editor', 'reader', 'critic', 'researcher'] as const) {
            const read = await call(kind, 'readKnowledge', {});

            expect({ kind, ok: read.ok }).toEqual({ kind, ok: true });
        }

        const read = await call('critic', 'readKnowledge', {});
        const data = read.data as Record<string, unknown>;

        expect(
            (data.entries as Array<{ topic: string; importance: string }>).map((row) => [row.topic, row.importance])
        ).toEqual([
            ['six round revolver', 'critical'],
            ['the light is engineering', 'high'],
            ['the harbour freezes', 'normal']
        ]);
        expect({ total: data.total, limit: data.limit, truncated: data.truncated }).toEqual({
            total: 3,
            limit: 40,
            truncated: false
        });

        const filtered = await call('critic', 'readKnowledge', { importance: 'critical' });
        expect((filtered.data as { total: number }).total).toBe(1);
    });

    it('bounds readKnowledge at 40 rows and says the page was truncated (T-7)', async () => {
        for (let index = 0; index < 41; index += 1)
            await call('researcher', 'writeKnowledge', {
                topic: `fact ${index}`,
                kind: 'fact',
                claim: `Fact number ${index} holds in this world.`,
                importance: 'normal',
                sources: [SOURCE],
                why: 'Bulk research for the cap.'
            });

        const read = await call('critic', 'readKnowledge', {});
        const data = read.data as Record<string, unknown>;

        expect({ total: data.total, limit: data.limit, truncated: data.truncated }).toEqual({
            total: 41,
            limit: 40,
            truncated: true
        });
        expect((data.entries as unknown[]).length).toBe(40);
        expect(data.note).toBe(
            'The page is bounded (T-7); filter by importance, kind, phase or topic to see the rest.'
        );
    });

    it('refuses structureSeed for every kind but the Editor (P10, §7.2)', async () => {
        for (const kind of ['writer', 'reader', 'critic', 'researcher'] as const) {
            const refused = await call(kind, 'structureSeed', seedCall());

            expect({ kind, ok: refused.ok, refused: refused.refused }).toEqual({
                kind,
                ok: false,
                refused: 'P10'
            });
        }

        const accepted = await call('editor', 'structureSeed', seedCall());

        expect(accepted.ok).toBe(true);
        expect(accepted.data).toMatchObject({
            seed_brief_id: 'seed_brief_0',
            seed_hash: seedHashOf(story.idea),
            status: 'accepted'
        });
        // D-51: the non-empty path is unchanged — the questions are stored verbatim, the waiver flag is
        // false, and the result names the dispatch. Only an empty list moves the pipeline to sampling.
        expect(accepted.data).toMatchObject({
            fields: {
                research_questions: ['What could 1880 North Sea lighthouse engineering actually do?'],
                research_waived: false
            },
            next: 'the pipeline may now dispatch research against this brief, one pass over the research_questions you listed; a Seed edit re-arms the structuring'
        });
        expect(store.seedBriefs.list()).toHaveLength(1);
    });

    it('reports the Seed hash on readSeed, so the Editor can send it back to structureSeed (§3.3)', async () => {
        const read = await call('editor', 'readSeed', {});
        const data = read.data as Record<string, unknown>;

        // The value `structureSeed` compares against; without it the Editor could only guess.
        expect(data.seed_hash).toBe(seedHashOf(story.idea));
        expect(read.rev).toBe(store.stories.require(story.id).rev);
    });

    it('refuses a Seed Brief derived from a Seed that moved, naming P5 (P5)', async () => {
        const refused = await call('editor', 'structureSeed', { ...seedCall(), seed_hash: 'deadbeef' });

        expect({ ok: refused.ok, refused: refused.refused, field: refused.field }).toEqual({
            ok: false,
            refused: 'P5',
            field: 'seed_hash'
        });
        expect(store.seedBriefs.list()).toEqual([]);
    });

    it('answers a second structureSeed for the same Seed with the existing brief (idempotence)', async () => {
        const first = await call('editor', 'structureSeed', seedCall());
        const second = await call('editor', 'structureSeed', seedCall());

        expect(second.repeat).toBe(true);
        expect(second.data).toMatchObject({
            seed_brief_id: (first.data as { seed_brief_id: string }).seed_brief_id,
            status: 'accepted'
        });
        expect(store.seedBriefs.list()).toHaveLength(1);
    });

    it('supersedes the accepted brief when the Seed changes, in one commit (P5, T-4)', async () => {
        await call('editor', 'structureSeed', seedCall());
        store.stories.update(
            story.id,
            { idea: 'A keeper, a light, a debt — and a second light.' },
            { why: 'The Author edits the Seed.' }
        );

        const reRead = store.stories.require(story.id);
        const accepted = await call('editor', 'structureSeed', {
            ...seedCall(),
            seed_hash: seedHashOf(reRead.idea),
            why: 'The Seed moved, so the brief is derived again.'
        });

        expect(accepted.ok).toBe(true);
        expect(store.seedBriefs.list().map((brief) => [brief.id, brief.status])).toEqual([
            ['seed_brief_0', 'draft'],
            ['seed_brief_1', 'accepted']
        ]);
    });

    // ── D-51: the research decision on the brief, and the empty research report ──────────────
    //
    // Three things have to be true for the waiver to be a DECISION rather than an accident: the arg is
    // required (an omission is a refusal, not a waiver), an empty list is stored AS an empty list (the
    // loop's gate reads the field's presence, not its emptiness alone), and the pass that finds nothing
    // has a report to end with that writes nothing.

    it('refuses a structureSeed call that leaves the research decision out (D-51, T-11)', async () => {
        const withoutDecision: Record<string, unknown> = { ...seedCall() };

        delete withoutDecision.research_questions;

        const refused = await call('editor', 'structureSeed', withoutDecision);

        // "No research" may only ever be a choice the Editor SENT. A tired context that simply forgets
        // the field must be refused naming it, not quietly waived — the whole Story's phase ① turns on
        // the difference, and a silent waiver would be invisible in the record.
        expect({ refused: refused.refused, tool: refused.tool, issues: refused.issues }).toEqual({
            refused: 'T-11',
            tool: 'structureSeed',
            issues: [{ field: 'research_questions', expected: 'an array of string' }]
        });
        // Refused BEFORE the write: no half-decided brief is left in the store.
        expect(store.seedBriefs.list()).toEqual([]);
    });

    it('stores research_questions: [] as the waiver it states, and repeats it on a second call (D-51)', async () => {
        const waived = await call('editor', 'structureSeed', { ...seedCall(), research_questions: [] });

        expect(waived.ok).toBe(true);
        expect(waived.data).toMatchObject({
            status: 'accepted',
            fields: {
                // Stored as an EMPTY ARRAY, not as an absent field: `records.ts:researchGate` reads the
                // difference as `waived` versus `needed`, and the loop's whole gate turns on it.
                research_questions: [],
                research_waived: true
            },
            next: 'the pipeline may now sample: this brief waives the research leg (D-51), so no Researcher is dispatched for it — a Seed edit re-arms the structuring'
        });
        expect(store.seedBriefs.list().map((brief) => [brief.id, brief.research_questions])).toEqual([
            ['seed_brief_0', []]
        ]);

        // A re-dispatched Editor converges on the row it already wrote, and the repeat answers WITH the
        // decision that row carries — it cannot be used to re-decide the waiver.
        const again = await call('editor', 'structureSeed', { ...seedCall(), research_questions: [] });

        expect(again.repeat).toBe(true);
        expect(again.data).toMatchObject({ seed_brief_id: 'seed_brief_0', research_questions: [], research_waived: true });
    });

    it('refuses a structureSeed call whose research_questions is not an array (D-51, T-11)', async () => {
        // A string is the shape a model reaches for when it means "one question". Guessing here would
        // store `[]` (a waiver) or split prose into questions, and both readings change the pipeline.
        const refused = await call('editor', 'structureSeed', {
            ...seedCall(),
            research_questions: 'What did the 1911 survey map measure?'
        });

        expect({ refused: refused.refused, tool: refused.tool, issues: refused.issues }).toEqual({
            refused: 'T-11',
            tool: 'structureSeed',
            issues: [
                {
                    field: 'research_questions',
                    expected: 'an array of string',
                    received: 'What did the 1911 survey map measure?'
                }
            ]
        });
        expect(store.seedBriefs.list()).toEqual([]);
    });

    it('reports "nothing needs research" as a report, writing nothing, for the Researcher alone (D-51, R1d)', async () => {
        await call('editor', 'structureSeed', { ...seedCall(), research_questions: [] });

        const rationale = 'The Seed states every fact this story leans on; nothing outside it needs establishing.';
        const reported = await call('researcher', 'reportNoResearch', {
            rationale,
            why: 'the pass read the brief and the knowledge and found no fact to establish (D-51)'
        });

        expect(reported.ok).toBe(true);
        expect(reported.summary).toBe('Research pass closed with nothing to record (Seed Brief seed_brief_0)');
        expect(reported.data).toEqual({
            research: 'none',
            // The brief is named from the RECORD, not from an arg: a run cannot answer a brief that is
            // not there, the same "compare, never trust" rule `structureSeed`'s hash enforces.
            seed_brief_id: 'seed_brief_0',
            seed_hash: seedHashOf(story.idea),
            research_questions: [],
            research_waived: true,
            knowledge_rows: 0,
            rationale,
            next: 'this research pass is closed with no Knowledge written; the loop may now sample the Seed Brief (D-51)'
        });
        expect(reported.notes).toEqual([
            'This brief waives the research leg (D-51): the report confirms the waiver from the Researcher side.',
            'Nothing was written: this is a report, not a Knowledge row (T-10 needs a citation) and not a task.'
        ]);

        // R1d's "nothing is manufactured": the store gained no Knowledge row, and the brief was not even
        // touched — an unchanged rev is the proof the pass wrote nothing at all.
        expect(store.knowledge.list()).toEqual([]);
        expect(store.seedBriefs.list().map((brief) => [brief.id, brief.rev])).toEqual([['seed_brief_0', 1]]);

        // §7.1/§7.2: the answer is the Researcher's alone, even though every kind holds `read` on
        // `knowledge` — a Writer answering its own research question would be an unlogged decision.
        for (const kind of ['writer', 'editor', 'reader', 'critic'] as const) {
            const refused = await call(kind, 'reportNoResearch', {
                rationale: 'a non-Researcher answers the pass anyway',
                why: 'T-1a: the refusal is the record'
            });

            expect({ kind, ok: refused.ok, refused: refused.refused }).toEqual({
                kind,
                ok: false,
                refused: 'P10'
            });
        }

        // The rationale is REQUIRED: "nothing needs research" is only a decision when the pass states
        // why, and the silence this tool replaces is exactly the run that could not.
        const silent = await call('researcher', 'reportNoResearch', { why: 'nothing to record' });

        expect({ refused: silent.refused, tool: silent.tool, issues: silent.issues }).toEqual({
            refused: 'T-11',
            tool: 'reportNoResearch',
            issues: [{ field: 'rationale', expected: 'string' }]
        });
    });

    // ── T10/F1 + F8: what `reportNoResearch` says when the RECORD does not state a waiver ─────
    //
    // D-51 is a one-way ratchet: only a stored EMPTY array is the Editor's waiver, and absence is
    // never one. The payload used to read `brief?.research_questions ?? []`, so a legacy row and a
    // missing brief both came back as `research_waived: true` with waiver prose — a tool answer
    // claiming a decision nobody made, next to a Story the loop still owed a research pass. These
    // rows pin the three record states (legacy fieldless, no brief at all, malformed value) against
    // the loop's own predicate, which is the agreement that has to hold.

    /** The note a report files when the RECORD states no waiver — asserted verbatim, three ways. */
    const NO_WAIVER_NOTE =
        'No research waiver is on this record, so none is claimed: the empty result is this pass\'s own, and the loop closes the research gate from this closed run (D-51).';

    /** The line every `reportNoResearch` answer carries, waived or not. */
    const REPORTS_ONLY_NOTE =
        'Nothing was written: this is a report, not a Knowledge row (T-10 needs a citation) and not a task.';

    /** `reportNoResearch`'s closing line, unchanged across all three record states. */
    const CLOSED_NEXT =
        'this research pass is closed with no Knowledge written; the loop may now sample the Seed Brief (D-51)';

    /**
     * A `seed_briefs` row written the way a pre-D-51 build wrote one: no `research_questions`
     * property at all (or, for the malformed case, a value that is not a list). The tool layer can no
     * longer produce either shape, so the store write is the only honest way to reach it.
     */
    function seedPreD51Brief(research_questions?: unknown): SeedBrief {
        return store.seedBriefs.create(
            {
                story_id: story.id,
                seed_hash: seedHashOf(story.idea),
                logline: 'A keeper learns the light was never the point.',
                protagonist: 'The keeper',
                want: 'To keep the light burning',
                obstacle: 'The debt the light was built on',
                stakes: 'The harbour',
                setting: 'A rock in the North Sea, 1880',
                world_rules: ['No magic; the light is engineering.'],
                promise: 'The debt is paid by the last page.',
                constraints: [],
                open_questions: [],
                // Only present when the caller says what the legacy row carries — `undefined` leaves the
                // key off the record entirely, which is the shape a row written before D-51 has.
                ...(research_questions === undefined ? {} : { research_questions }),
                status: 'accepted'
            } as unknown as Omit<SeedBrief, 'id' | 'rev' | 'created_at' | 'updated_at'>,
            { run_ref: null, why: 'seed: a Seed Brief written before the research_questions field existed (D-51)' }
        ) as SeedBrief;
    }

    it('reports a legacy fieldless brief as the pass\'s own empty result, never as a waiver (D-51, T10/F1)', async () => {
        const legacy = seedPreD51Brief();

        expect(Object.prototype.hasOwnProperty.call(legacy, 'research_questions')).toBe(false);

        const rationale = 'The Seed states every fact this story leans on; nothing outside it needs establishing.';
        const reported = await call('researcher', 'reportNoResearch', {
            rationale,
            why: 'the pass read the brief and found no fact to establish (D-51)'
        });

        expect(reported.ok).toBe(true);
        expect(reported.data).toEqual({
            research: 'none',
            seed_brief_id: 'seed_brief_0',
            seed_hash: seedHashOf(story.idea),
            // `null`, NOT `[]`: the record states nothing, and `[]` would be the Editor's answer.
            research_questions: null,
            research_waived: false,
            knowledge_rows: 0,
            rationale,
            next: CLOSED_NEXT
        });
        expect(reported.notes).toEqual([NO_WAIVER_NOTE, REPORTS_ONLY_NOTE]);

        // The agreement that matters: the loop reads the SAME row as owed work, so the tool's answer and
        // the gate cannot point in different directions (test-only import of the loop's predicate).
        expect(researchWaived(legacy)).toBe(false);
        expect(researchGate(store, store.stories.require(story.id), legacy)).toBe('needed');
    });

    it('reports a run that answered with no accepted brief as no waiver (T10/F1)', async () => {
        const rationale = 'There is no brief for this pass to answer; nothing outside the Seed needs establishing.';
        const reported = await call('researcher', 'reportNoResearch', {
            rationale,
            why: 'the pass ran before any brief was accepted (D-51)'
        });

        expect(reported.ok).toBe(true);
        expect(reported.summary).toBe('Research pass closed with nothing to record');
        expect(reported.data).toEqual({
            research: 'none',
            seed_brief_id: null,
            seed_hash: null,
            research_questions: null,
            research_waived: false,
            knowledge_rows: 0,
            rationale,
            next: CLOSED_NEXT
        });
        expect(reported.notes).toEqual([NO_WAIVER_NOTE, REPORTS_ONLY_NOTE]);
        // Nothing was written — the report is still zero-write with no brief to name.
        expect(store.seedBriefs.list()).toEqual([]);
        expect(store.knowledge.list()).toEqual([]);
    });

    it('reads a malformed stored list as "the record states nothing", in the tool and the loop alike (T10/F8)', async () => {
        // A `''` where a list belongs: `'' !== undefined && ''.length === 0` used to read as a waiver in
        // the tool while `records.ts:researchWaived` (an `Array.isArray` read) still owed the pass.
        const malformed = seedPreD51Brief('');

        const reported = await call('researcher', 'reportNoResearch', {
            rationale: 'The questions this pass was given are answered by the Seed itself.',
            why: 'the pass closed without a Knowledge row (D-51)'
        });

        expect(reported.data).toMatchObject({ research_questions: null, research_waived: false });
        expect(researchWaived(malformed)).toBe(false);
        expect(researchGate(store, store.stories.require(story.id), malformed)).toBe('needed');

        // `structureSeed`'s idempotent repeat echoes the same reading rather than a waiver it did not
        // earn, so no path through the knowledge surface turns a malformed row into a decision.
        const again = await call('editor', 'structureSeed', seedCall());

        expect(again.repeat).toBe(true);
        expect(again.data).toMatchObject({
            seed_brief_id: 'seed_brief_0',
            research_questions: null,
            research_waived: false
        });
    });

    // ── T10/F9: a blank research entry is not an answer the Editor can be credited with ────────

    it('refuses a research_questions entry that is blank instead of cleaning it into a waiver (D-51, T10/F9)', async () => {
        const question = 'What could 1880 North Sea lighthouse engineering actually do?';

        // `['']` cleaned to `[]` is a WAIVER nobody voted for, and `['q', '  ']` cleaned to `['q']` is a
        // scope change nobody made. Both are refusals naming the entry, not silent normalisation.
        for (const value of [[''], ['   '], ['\t'], [question, '  '], [' ', question]]) {
            const refused = await call('editor', 'structureSeed', {
                ...seedCall(),
                research_questions: value
            });

            expect({ value, refused: refused.refused, field: refused.field, rule: refused.rule }).toEqual({
                value,
                refused: 'T-11',
                field: 'research_questions',
                rule: 'D-51'
            });
            // The refusal names WHICH entry, so the fix is one turn instead of a guess.
            expect(refused.index).toBe(value.findIndex((entry) => entry.trim() === ''));
            expect(refused.fix).toContain('[]');
            // Refused before the write: no half-decided brief is left behind (T-1a).
            expect(store.seedBriefs.list()).toEqual([]);
        }
    });

    it('still trims and dedups the research list it accepts, and stores what the Editor meant (D-51, T10/F9)', async () => {
        const first = 'What could 1880 North Sea lighthouse engineering actually do?';
        const second = 'What did the 1911 survey map actually measure?';

        const built = await call('editor', 'structureSeed', {
            ...seedCall(),
            research_questions: [`  ${first}  `, first, ` ${second} `]
        });

        expect(built.ok).toBe(true);
        expect(built.data).toMatchObject({
            fields: { research_questions: [first, second], research_waived: false }
        });
        expect(store.seedBriefs.list().map((brief) => brief.research_questions)).toEqual([[first, second]]);
    });

    it('retires a knowledge entry to low with the mark kept for the audit, and refuses a second retire', async () => {
        await call('researcher', 'writeKnowledge', {
            topic: 'the harbour freezes',
            kind: 'place',
            claim: 'The harbour freezes in January.',
            detail: 'Ice from the 5th.',
            importance: 'high',
            sources: [SOURCE],
            why: 'It decides the finale.'
        });

        const retired = await call('researcher', 'retireKnowledge', {
            knowledge_id: 'knowledge_entry_0',
            expects: [{ id: 'knowledge_entry_0', rev: 1 }],
            why: 'The scene moved south.'
        });

        expect(retired.ok).toBe(true);
        expect(store.knowledge.list()[0]).toMatchObject({
            importance: 'low',
            detail: 'Ice from the 5th.\n\n(retired) The scene moved south.'
        });

        const again = await call('researcher', 'retireKnowledge', {
            knowledge_id: 'knowledge_entry_0',
            expects: [{ id: 'knowledge_entry_0', rev: 2 }],
            why: 'Nothing changed.'
        });

        expect({ ok: again.ok, refused: again.refused }).toEqual({ ok: false, refused: 'T-11' });
    });

    it('refuses a stale retire with the current record returned (T-4)', async () => {
        await call('researcher', 'writeKnowledge', {
            topic: 'the harbour freezes',
            kind: 'place',
            claim: 'The harbour freezes in January.',
            importance: 'high',
            sources: [SOURCE],
            why: 'It decides the finale.'
        });
        // Move the row, so the rev the caller read is stale.
        store.knowledge.update('knowledge_entry_0', { seen_count: 2 }, { why: 'moved by another run' });

        const stale = await call('researcher', 'retireKnowledge', {
            knowledge_id: 'knowledge_entry_0',
            expects: [{ id: 'knowledge_entry_0', rev: 1 }],
            why: 'The scene moved south.'
        });

        expect({ cas_conflict: stale.cas_conflict, refused: stale.refused }).toEqual({
            cas_conflict: true,
            refused: 'T-4'
        });
        expect(store.knowledge.list()[0]?.importance).toBe('high');
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
        // §7.2's five dispatched kinds: the Researcher is a first-class session kind, so the
        // pinned context carries it exactly like the original four.
        roleKind: 'writer' | 'editor' | 'critic' | 'reader' | 'researcher';
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
                roleKind: 'writer' | 'editor' | 'critic' | 'reader' | 'researcher';
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

        const answer = await context.services.delegate!('reader_2', 'Which draft pays the setup off?');

        expect(calls).toEqual([{ role: 'reader_2', task: 'Which draft pays the setup off?' }]);
        expect(answer).toEqual({ ok: true, summary: 'The bell, not the map.' });
    });
});

/**
 * Phase ①'s finding attribution (T6/R2c, D-33, documents/specifications.md §15 step 11).
 *
 * Every phase-① gate that decides whether a defect is work — the sign-off's blocking set, the
 * verification queue, and the selection's retirement of a lost draft — reads `related_refs` to learn
 * WHICH DRAFT the finding describes. A finding filed without that id, or with the id of a draft the
 * selection has since set aside, can never be decided: the Editor's verification pass reads the draft
 * the Summary carries, which never contained the defect. So the one id is asked for where it is cheap
 * to ask — at filing — and the refusal is actionable rather than a silent acceptance.
 */
describe('phase ① finding attribution on raiseFinding (T6/R2c, D-33)', () => {
    let store: Store;
    let story: Story;
    let chapter: Chapter;

    /** A Summary draft the way phase ① leaves one behind: the Summary row is its unit (§4.15, §6.2a). */
    function seedSummaryRevision(unitRef: string, state: Revision['state'], round: number): Revision {
        return store.revisions.create(
            {
                story_id: story.id,
                unit_kind: 'summary',
                unit_ref: unitRef,
                round,
                body: { premise: 'A keeper, a light, a debt.', logline: 'The keeper logs her own relief.' },
                state,
                verdict_refs: []
            },
            { why: 'seed: summary draft' }
        ) as Revision;
    }

    /** Phase ① with a completed selection: `revision_0` is carried and `revision_1` was set aside. */
    beforeEach(() => {
        const world = seedWorld();

        store = world.store;
        story = world.story;
        chapter = world.chapter;

        store.stories.update(story.id, { phase: 'summary' }, { why: 'seed: phase ①' });
        seedSummaryRevision('summary_0', 'selected', 2);
        seedSummaryRevision('summary_0', 'competing', 1);
    });

    async function file(args: Record<string, unknown>, roleKind = 'reader'): Promise<ToolResult> {
        const runtime = createToolRuntime(store);
        const context: RunToolContext = runtime.createContext(sessionFor(story.id, roleKind));

        return runtime.execute(context, 'raiseFinding', {
            target_ref: 'summary_0',
            criterion_ref: 'C-3',
            title: 'The relief arrives before the storm',
            evidence: 'summary_0 logline',
            cost: 'major',
            why: 'Triage.',
            ...args
        });
    }

    it('refuses a Summary finding that names no draft, asking for the revision the Summary carries', async () => {
        const result = await file({});

        expect(result).toMatchObject({
            ok: false,
            refused: 'D-33',
            field: 'related_refs',
            expected: ['revision_0'],
            fix: 'call raiseFinding again with related_refs including revision_0 — the Summary revision you actually read'
        });
        expect(result.message).toContain('has to name the draft it describes');
        // The row is not filed "with the ref missing": an unattributable phase-① defect is the exact
        // record that used to hold the round forever, so nothing lands at all.
        expect(store.findings.list()).toEqual([]);
    });

    it('refuses a finding naming a draft the selection set aside, and names the draft that replaced it', async () => {
        const result = await file({ related_refs: ['revision_1'] });

        expect({ ok: result.ok, refused: result.refused, field: result.field, expected: result.expected }).toEqual({
            ok: false,
            refused: 'D-33',
            field: 'related_refs',
            expected: ['revision_0']
        });
        expect(result.message).toBe(
            'Rule: D-33 — revision_1 is not the draft the Summary carries — the selection replaced it with revision_0, ' +
                'so a defect written about it is history, not work the round can act on (D-33, §6.6).'
        );
        expect(store.findings.list()).toEqual([]);
    });

    it('files the finding that names the carried draft, keeping the refs it propagates on (L-11a)', async () => {
        const result = await file({ related_refs: ['revision_0'] });

        expect(result.ok).toBe(true);
        expect(store.findings.list().map((finding) => `${finding.id}:${finding.target_ref}:${finding.state}`)).toEqual([
            'finding_0:summary_0:unconfirmed'
        ]);
        expect(store.findings.list()[0].related_refs).toEqual(['revision_0']);
    });

    it('leaves the shapes the rule is not about alone: a whole-Story defect, a chapter defect, and a round before its first selection', async () => {
        // L-11a's whole-Story finding: the Story row is the target and there is no draft to name, so
        // this is the legacy shape the dashboard still has to show — refusing it would drop a defect.
        const wholeStory = await file({ target_ref: story.id });

        expect(wholeStory.ok).toBe(true);

        // A chapter target: the defect is aimed at its own row, where there is no competing-draft
        // question to answer, and phase ①'s rule has nothing to say.
        const chapterFinding = await file({ target_ref: chapter.id, criterion_ref: 'C-7' });

        expect(chapterFinding.ok).toBe(true);

        // Round 1, before any selection installed a draft: nothing to name, so nothing to refuse.
        const fresh = seedWorld();

        fresh.store.stories.update(fresh.story.id, { phase: 'summary' }, { why: 'seed: phase ①, no selection' });
        const runtime = createToolRuntime(fresh.store);
        const beforeSelection = await runtime.execute(
            runtime.createContext(sessionFor(fresh.story.id, 'reader')),
            'raiseFinding',
            {
                target_ref: 'summary_0',
                criterion_ref: 'C-3',
                title: 'Filed before the first selection',
                evidence: 'summary_0 premise',
                cost: 'major',
                why: 'Triage.'
            }
        );

        expect(beforeSelection.ok).toBe(true);
        expect(fresh.store.findings.list().map((finding) => `${finding.id}:${finding.target_ref}`)).toEqual([
            'finding_0:summary_0'
        ]);
    });
});

// ── D-33b / T5: the two finding kinds, and the fingerprint that separates them ────────────────
//
// WHY THIS BLOCK EXISTS: the Author's loop was spending rounds on disputes. A Critic compared the
// text to the Seed, found the Seed silent about something, filed it, and the Editor's admissibility
// rule (D-33) disputed it — correctly, because silence is not a defect — while the same pass had no
// honest way to say "this change would make the book better", since a review pass bans Ideas (D-26,
// D-30). §4.10 now carries `kind`, and three things have to stay true:
//
//   1. a `proposal` is ACCEPTED and travels (tool payload → row → every read), because the marker
//      is the only thing that tells the Editor which of the two questions to answer;
//   2. `issue` remains the default in both directions — a call that names no `kind` stores one, and a
//      row written before the field existed still reads as one;
//   3. D-16's dedupe is UNBROKEN by the new component. `issue` keeps the pre-field three-part hash, so
//      a legacy row and a new `issue` report still merge, while an improvement with the same wording
//      stays its own row on purpose (different claim, different Editor rule).
//
// The exact-value discipline holds: the refusal sentence, the stored field, the row ids and the
// fingerprint equality are all pinned, because each is a contract another module reads.
describe('the two finding kinds and the fingerprint that separates them (D-33b, D-16)', () => {
    let store: Store;
    let story: Story;
    let chapter: Chapter;

    beforeEach(() => {
        const world = seedWorld();
        store = world.store;
        story = world.story;
        chapter = world.chapter;
    });

    /** One `raiseFinding` call as one role kind, built the way the run layer builds a context. */
    async function call(roleKind: string, args: Record<string, unknown>): Promise<ToolResult> {
        const runtime = createToolRuntime(store);
        return runtime.execute(runtime.createContext(sessionFor(story.id, roleKind)), 'raiseFinding', args);
    }

    /**
     * The SAME call as a DIFFERENT review pass (D-33c).
     *
     * D-33c's no-mixing rule attributes findings to the RUN that filed them, so these kind-separation
     * and dedupe tests — whose subject is the FINGERPRINT, not the pass order — have to file across two
     * passes now. A distinct `runId` is all that changes: the row, the role and every other input stay
     * exactly as they were, so what the assertions pin is still the fingerprint contract.
     */
    async function callInPass(pass: string, roleKind: string, args: Record<string, unknown>): Promise<ToolResult> {
        const runtime = createToolRuntime(store);
        const context = runtime.createContext(sessionFor(story.id, roleKind, { runId: `run_${roleKind}_${pass}` }));

        return runtime.execute(context, 'raiseFinding', args);
    }

    /**
     * Closes one finding the way the loop closes it, so a test can say "this issue is resolved" without
     * re-running the whole verify → approve → fix chain (D-33c reads only the state, and
     * `loop/types.ts:CLOSED_FINDING_STATES` is the one list that says which states those are).
     */
    function resolveIssue(findingId: string, state: 'fixed' | 'discarded' = 'fixed'): void {
        const row = store.findings.require(findingId);

        store.findings.update(findingId, { state }, { why: `seed: the issue reached ${state} (D-33c)` }, [
            { id: findingId, rev: row.rev }
        ]);
    }

    /** The proposal the fix is about: `detail` is present so D-30 is never what these tests read. */
    const proposal = (extra: Record<string, unknown> = {}) => ({
        target_ref: chapter.id,
        criterion_ref: 'C-3',
        title: 'let the keeper lie first',
        detail: 'chapter_0 section_1 has him tell the truth at once; opening on the lie gives chapter 2 its tension',
        evidence: 'chapter_0 section_1: "he told them the truth"',
        cost: 'major',
        kind: 'proposal',
        why: 'It costs one line and pays the middle of the book.',
        ...extra
    });

    /** The refusal prefix `tools/index.ts` adds before the sentence the crew reads. */
    const refusal = (rule: string, message: string) => `Rule: ${rule} — ${message}`;

    /**
     * The fingerprint EXACTLY as §4.10 computed it before `kind` was a component: the three-part form,
     * written out here rather than imported, so the test pins the legacy value and not a helper that
     * could quietly move with the implementation.
     */
    const legacyFingerprint = (title: string) =>
        computeFingerprint(`${chapter.id}|C-3|${normalizeForFingerprint(title)}`);

    it('accepts a proposal, stores the kind on the row, and says the Editor will weigh it (D-33b)', async () => {
        const result = await call('critic', proposal());

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            id: 'finding_0',
            kind: 'proposal',
            cost: 'major',
            state: 'unconfirmed',
            seen_count: 1
        });
        // The ROW carries it, not only the reply: the Editor's verify thread, the queue, and the Writer's
        // fix prompt all read the record.
        expect(store.findings.require('finding_0')).toMatchObject({ kind: 'proposal', cost: 'major' });
        // The Critic is told, in the result it is reading right now, which rule the Editor will run —
        // otherwise the next pass re-files the same wish as a defect.
        expect((result.notes as string[])[1]).toBe(
            'This is a proposal, not a defect: the Editor weighs it on whether the book is better for a Writer pass, never on whether the Seed promised the change.'
        );
    });

    it('stores an omitted kind as the issue it has always meant (D-33b, D-16)', async () => {
        const { kind: _kind, ...withoutKind } = proposal();
        const result = await call('critic', withoutKind);

        expect(result.data).toMatchObject({ kind: 'issue' });
        // Written explicitly, so a new row is self-describing; the kind-less row stays the legacy case
        // and `tools/reader.ts:kindOf` is the one place the default is decided.
        expect(store.findings.require('finding_0').kind).toBe('issue');
    });

    it('refuses an unknown kind at the schema, naming the accepted set, and files nothing (T-11, D-33b)', async () => {
        // WHY THIS IS PINNED AND THE OMITTED CASE ALONE IS NOT ENOUGH: `tools/reader.ts:kindOf`
        // coerces ANY unknown value to `issue` on purpose, so a row can only be trusted while the
        // SCHEMA refuses first (T-11 puts enforcement in the tool, not the prompt). This is the pin
        // that says a `kind: 'banana'` call never reaches that coercion — the Critic is sent the
        // accepted set and the proposal is not silently re-classified into a defect claim the Editor
        // will dispute on absence grounds. Were the enum ever loosened, this test fails instead of a
        // coercion quietly deciding the claim type.
        const result = await call('critic', proposal({ kind: 'banana' }));

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('T-11');
        expect(result.message).toBe(refusal('T-11', 'raiseFinding was called with an invalid request body'));
        expect(result.tool).toBe('raiseFinding');
        // The field, the accepted values, and what was actually sent — the three things that let the
        // same pass fix the call in one turn rather than guess at another spelling.
        expect(result.issues).toEqual([{ field: 'kind', expected: 'one of issue | proposal', received: 'banana' }]);
        expect((result.shape as Record<string, unknown>).enums).toMatchObject({ kind: ['issue', 'proposal'] });
        // Validation runs before the tool body, so nothing was half-filed and no coerced `issue` row
        // exists wearing the proposal's title (P1).
        expect(store.findings.list()).toEqual([]);
    });

    it('refuses a proposal at cost critical and sends it back as major at most (D-33b, D-35)', async () => {
        const result = await call('critic', proposal({ cost: 'critical' }));

        expect(result).toMatchObject({ ok: false, refused: 'D-33b' });
        expect(result.message).toBe(
            refusal(
                'D-33b',
                'a `kind: proposal` finding cannot be `critical`: `critical` is a contradiction the text cannot live with — of itself, of the Seed, or of critical Knowledge — and a proposal the Seed never promised is not one.'
            )
        );
        // The fix names the ladder the Critic may actually use, which is the difference between a
        // proposal that comes back `major` and a pass that burns itself re-triaging. `refusalResult`
        // spreads the ToolRefusal details at the top level of the result, so they are pinned there.
        expect(result).toMatchObject({
            ok: false,
            refused: 'D-33b',
            field: 'cost',
            expected: ['major', 'minor', 'taste'],
            fix: "call raiseFinding again with cost `major` at most and kind `proposal`, or with kind `issue` if the draft contradicts something it states"
        });
        // Nothing half-filed (P1).
        expect(store.findings.list()).toEqual([]);
    });

    // D-33b's MIRROR rule, and the half that keeps the taxonomy from leaking the long way round. A Critic
    // that files a word-choice wish as a `taste`-cost ISSUE puts a preference in the defect column: the
    // Author's queue reads it as a break, the Editor's absence gate disputes it, and the pass that could
    // have said "here is a better version" is spent on a dispute. So the pairing is refused at the same
    // gate, in the same shape, and the fix sentence names the kind the preference actually belongs to.
    it('refuses an issue at cost taste and sends it back as a proposal or a minor at least (D-33b)', async () => {
        // The default kind — an OMITTED `kind` — is what the rule has to catch too, because a taste-cost
        // call that names no kind is exactly the mis-filing this rule exists to refuse.
        const { kind: _kind, ...withoutKind } = proposal();
        const result = await call('critic', { ...withoutKind, cost: 'taste' });

        expect(result).toMatchObject({ ok: false, refused: 'D-33b' });
        expect(result.message).toBe(
            refusal(
                'D-33b',
                'an `issue` cannot be `taste`: an Issue is rated `critical`, `major` or `minor` — a preference is a Proposal (`kind: proposal`), not a defect.'
            )
        );
        expect(result).toMatchObject({
            ok: false,
            refused: 'D-33b',
            field: 'cost',
            expected: ['critical', 'major', 'minor'],
            fix: "call raiseFinding again with kind `proposal` and cost `taste` when this is a preference, or with cost `minor` at least when it really is a defect"
        });
        expect(store.findings.list()).toEqual([]);

        // The same row marked honestly is accepted: the rule moves the LABEL, it never removes the rung.
        const asProposal = await call('critic', proposal({ cost: 'taste' }));

        expect(asProposal).toMatchObject({ ok: true, data: { id: 'finding_0', kind: 'proposal', cost: 'taste' } });
    });

    it('keeps a proposal and an issue with identical wording apart, and dedupes each inside its kind (D-16, D-33b)', async () => {
        const first = await call('critic', proposal());
        // The same proposal seen again: D-16 counts it, it does not open a second claim.
        const again = await call('critic', proposal());
        // The SAME sentence filed as a defect claim: same target, same criterion, same title. It has to
        // stay a second row, because one says "this is broken" and the other says "this would be better"
        // and the Editor answers them by opposite rules.
        //
        // It is filed in a SECOND pass (D-33c): an issue and a proposal never share a review pass, so a
        // single-pass fixture can no longer produce one of each — and this test's subject is the
        // FINGERPRINT, which the pass boundary does not touch.
        const asIssue = await callInPass('next', 'critic', proposal({ kind: 'issue' }));

        expect(first).toMatchObject({ ok: true });
        expect(again).toMatchObject({ ok: true, repeat: true, finding_id: 'finding_0' });
        // A new row carries no `repeat` flag at all (`utilities.ts:repeatResult` is the only thing that
        // sets it), and the kind it filed is in the payload.
        expect(asIssue).toMatchObject({ ok: true });
        expect(asIssue.repeat).toBeUndefined();
        expect(asIssue.data).toMatchObject({ id: 'finding_1', kind: 'issue' });
        expect(store.findings.list().map((finding) => `${finding.id}:${finding.kind}:${finding.seen_count}`)).toEqual([
            'finding_0:proposal:2',
            'finding_1:issue:1'
        ]);
        // The two rows are separated BY the fingerprint, not by an accident of insertion order.
        const [proposalRow, issue] = store.findings.list();
        expect(proposalRow.fingerprint).not.toBe(issue.fingerprint);
        expect((asIssue.data as { fingerprint: string }).fingerprint).toBe(issue.fingerprint);
    });

    it('still dedupes a row written before the kind field against a new issue raise (D-16 back-compat)', async () => {
        const title = 'The keeper knows the answer too early';
        const args = {
            target_ref: chapter.id,
            criterion_ref: 'C-3',
            title,
            evidence: 'chapter_0 section_2: "he already knew"',
            cost: 'major',
            why: 'It spoils the middle of the book.'
        };

        // A row exactly as §4.10 stored it before `kind`: no `kind` field at all, and a three-part
        // fingerprint. This is every open finding on every Story in the wild.
        store.findings.create(
            {
                story_id: story.id,
                target_ref: chapter.id,
                criterion_ref: 'C-3',
                title,
                evidence: 'chapter_0 section_2: "he already knew"',
                cost: 'major',
                fingerprint: legacyFingerprint(title),
                state: 'unconfirmed',
                seen_count: 1
            },
            { why: 'seed: a finding raised before `kind` existed (D-16)' }
        );

        // The hash contract, pinned directly: `issue` IS the legacy form, which is why no stored row has
        // to be re-hashed and why an old finding cannot silently open a second row.
        expect(fingerprintFinding(chapter.id, 'C-3', title)).toBe(legacyFingerprint(title));
        expect(fingerprintFinding(chapter.id, 'C-3', title, 'proposal')).not.toBe(legacyFingerprint(title));

        // The behaviour that follows from it: a new raise that names no `kind` bumps the legacy row.
        const repeat = await call('reader', args);

        expect(repeat).toMatchObject({ ok: true, repeat: true, finding_id: 'finding_0' });
        expect(store.findings.list().length).toBe(1);
        expect(store.findings.require('finding_0')).toMatchObject({ seen_count: 2 });
        // The legacy row is still read as an issue by every projection that names the field.
        expect(repeat.data).toMatchObject({ kind: 'issue' });

        // And the same wording as a proposal is NEW information about the same passage, so it opens its
        // own row rather than quietly counting against a defect nobody filed.
        //
        // The defect is RESOLVED first (D-33c): with `finding_0` still open it is an unresolved ISSUE,
        // and a proposal is not filable over one — that is the whole rule. Closing it is also the honest
        // reading of what this test is claiming, because a proposal that replaces a fixed defect is
        // exactly the "new information about the same passage" case, and D-16's dedupe skips closed rows
        // either way, so nothing here leans on the state.
        resolveIssue('finding_0');

        const improved = await call('reader', { ...args, kind: 'proposal' });

        expect(improved).toMatchObject({ ok: true });
        expect(improved.repeat).toBeUndefined();
        expect(improved.data).toMatchObject({ id: 'finding_1', kind: 'proposal' });
        expect(store.findings.list().map((finding) => `${finding.id}:${finding.seen_count}`)).toEqual([
            'finding_0:2',
            'finding_1:1'
        ]);
    });

    it('refuses a Critic proposal with no detail, the same D-30 gate a defect pays (D-30, D-33b)', async () => {
        const { detail: _detail, ...noDetail } = proposal();
        const result = await call('critic', noDetail);

        expect(result).toMatchObject({ ok: false, refused: 'D-30' });
        // A proposal the Editor has to re-read the draft to understand costs the very pass it proposes.
        expect(store.findings.list()).toEqual([]);
    });

    it('tells the Writer it is delivering a proposal, on the task an approval opens (D-34, D-33b)', async () => {
        const raised = await call('editor', proposal());
        expect(raised).toMatchObject({ ok: true, data: { state: 'confirmed', kind: 'proposal' } });

        const runtime = createToolRuntime(store);
        const context = runtime.createContext(sessionFor(story.id, 'editor'));
        const approved = await runtime.execute(context, 'approveFinding', {
            finding_id: 'finding_0',
            decision: 'approve',
            why: 'The change is worth one line.'
        });

        expect(approved.ok).toBe(true);
        // The task detail is what the fix prompt renders as `work:`; without the marker a sample reads a
        // proposal as a break and makes the smallest change instead of the better one.
        expect(store.tasks.list().map((task) => task.detail)).toEqual([
            'chapter_0 section_1 has him tell the truth at once; opening on the lie gives chapter 2 its tension\nCost: major\nKind: proposal\nCriterion: C-3\nFinding: finding_0\nApproved by: editor_1'
        ]);
    });
});

// ── D-33c / D-33d: issues come first, at the gate and at the approval ──────────────────────────
//
// WHY THIS BLOCK EXISTS: D-33b split the findings into the two kinds and stopped there, so a review
// pass could answer BOTH questions at once and the round paid for it — the Critic filed three defects
// and one improvement, the dial approved by cost and not by kind, and a Writer pass went to the
// suggestion while the crew's own agreed defects sat unworked. Four things have to stay true, and each
// is pinned with the exact sentence the crew reads, because that sentence is what makes the next turn
// correct without a re-read of the docs:
//
//   1. a PROPOSAL WAITS FOR THE ISSUES (D-33c), counted and named in the refusal;
//   2. an ISSUE AND A PROPOSAL NEVER SHARE A PASS (D-33c), in the direction the first rule cannot
//      cover — the proposal that came first;
//   3. the release is EXACT: `fixed` and `discarded` open the gate, and so does `disputed` — the
//      Editor's "not a defect", which drives no work and holds nothing (2026-11-25). The three states
//      that DO hold are `unconfirmed`, `confirmed` and `approved` (`loop/types.ts:ISSUE_HOLDING_STATES`);
//   4. APPROVAL PAYS THE SAME BILL (D-33d): the Editor cannot approve a proposal over an open issue on
//      any decision that means "do it", while discarding one and approving an issue both stay legal.
describe('issues come first, at the filing gate and at the approval (D-33c, D-33d)', () => {
    let store: Store;
    let story: Story;
    let chapter: Chapter;

    beforeEach(() => {
        const world = seedWorld();
        store = world.store;
        story = world.story;
        chapter = world.chapter;
    });

    /** One `raiseFinding` call as one role kind, optionally as a NAMED run (D-33c's pass attribution). */
    async function call(
        roleKind: string,
        args: Record<string, unknown>,
        runId?: string
    ): Promise<ToolResult> {
        const runtime = createToolRuntime(store);
        const context = runtime.createContext(sessionFor(story.id, roleKind, { runId }));

        return runtime.execute(context, 'raiseFinding', args);
    }

    /** One `approveFinding` call, the way the Editor's `verify_findings` thread makes it. */
    async function approve(findingId: string, decision: string): Promise<ToolResult> {
        const runtime = createToolRuntime(store);
        const context = runtime.createContext(sessionFor(story.id, 'editor'));

        return runtime.execute(context, 'approveFinding', {
            finding_id: findingId,
            decision,
            why: 'The Editor decided it.'
        });
    }

    /** The proposal the rules are about. `detail` is present, so D-30 is never what these tests read. */
    const proposal = (extra: Record<string, unknown> = {}) => ({
        target_ref: chapter.id,
        criterion_ref: 'C-3',
        title: 'let the keeper lie first',
        detail: 'chapter_0 section_1 has him tell the truth at once; opening on the lie gives chapter 2 its tension',
        evidence: 'chapter_0 section_1: "he told them the truth"',
        cost: 'major',
        kind: 'proposal',
        why: 'It costs one line and pays the middle of the book.',
        ...extra
    });

    /** The defect the rules put first. Same passage, so the two rows are about the same text. */
    const issue = (extra: Record<string, unknown> = {}) => ({
        target_ref: chapter.id,
        criterion_ref: 'C-3',
        title: 'the relief arrives before the storm',
        detail: 'chapter_0 section_2 resolves the debt before the storm that was supposed to force it',
        evidence: 'chapter_0 section_2: "the debt was paid, and then the storm came"',
        cost: 'major',
        kind: 'issue',
        why: 'The order of the two scenes costs the ending its force.',
        ...extra
    });

    /**
     * A finding on the record already, in the state the test is asking about.
     *
     * Seeded directly rather than raised: a raised row is `unconfirmed` by D-33 and the tests below need
     * `confirmed`, `approved`, `disputed`, `fixed` and `discarded` too, and D-33c reads ONLY the stored
     * state (`loop/records.ts:openIssueFindings`), so seeding the row pins the rule against the state
     * rather than against the chain that would have produced it.
     */
    function seedFinding(kind: 'issue' | 'proposal', state: string, cost = 'major'): string {
        const row = store.findings.create(
            {
                story_id: story.id,
                target_ref: chapter.id,
                criterion_ref: 'C-3',
                title: `seed ${kind} in ${state}`,
                evidence: 'chapter_0 section_1',
                cost: cost as 'critical' | 'major' | 'minor' | 'taste',
                kind,
                fingerprint: `seed-${kind}-${state}-${cost}`,
                state: state as never,
                seen_count: 1
            },
            { why: `seed: a ${kind} sitting in ${state}` }
        );

        return row.id;
    }

    /** The refusal prefix `tools/index.ts` adds before the sentence the crew reads. */
    const refusal = (rule: string, message: string) => `Rule: ${rule} — ${message}`;

    it('files a proposal the Story has no defect behind (D-33c)', async () => {
        const result = await call('critic', proposal());

        expect(result).toMatchObject({ ok: true, data: { id: 'finding_0', kind: 'proposal' } });
        expect(store.findings.list().map((finding) => `${finding.id}:${finding.kind}:${finding.state}`)).toEqual([
            'finding_0:proposal:unconfirmed'
        ]);
    });

    it('refuses a proposal while an issue is open, counting it and naming it (D-33c)', async () => {
        seedFinding('issue', 'unconfirmed');
        const result = await call('critic', proposal());

        expect(result).toMatchObject({ ok: false, refused: 'D-33c', field: 'kind', expected: ['issue'] });
        // The sentence carries the COUNT and the ROW, because "not yet" without the number is a guess at
        // how much work is left, and the crew that cannot see the queue has to re-read it with a tool.
        expect(result.message).toBe(
            refusal(
                'D-33c',
                'a proposal cannot be filed while 1 issue is unresolved — finding_0 (major, unconfirmed) — because a suggestion about a book that still has defects is not what the round is for. An issue holds a proposal down only while it is `unconfirmed`, `confirmed` or `approved`; one the Editor marked `disputed` is not a defect and releases it, exactly as `fixed` or `discarded` does (D-33c).'
            )
        );
        // The full set rides in the detail, so a refusal over forty issues still names all forty.
        expect(result).toMatchObject({ open_issues: 1, open_issue_refs: ['finding_0'] });
        expect(result.fix).toBe(
            'resolve every open issue first — verify it (confirm or dispute), approve it, fix it or discard it — then call raiseFinding again with kind `proposal` — or file this as `kind: issue` if the draft actually breaks something'
        );
        // Nothing half-filed, and no `seen_count` moved on the proposal row either: the refusal runs
        // BEFORE D-16's dedupe, so an inadmissible proposal cannot advance the loop's no-progress ledger.
        expect(store.findings.list().map((finding) => `${finding.id}:${finding.kind}:${finding.seen_count}`)).toEqual([
            'finding_0:issue:1'
        ]);
    });

    it('refuses a proposal that follows an issue raised moments ago in the SAME pass (D-33c)', async () => {
        const raised = await call('critic', issue());

        expect(raised).toMatchObject({ ok: true, data: { id: 'finding_0', kind: 'issue' } });

        const result = await call('critic', proposal());

        expect(result).toMatchObject({ ok: false, refused: 'D-33c', open_issues: 1, open_issue_refs: ['finding_0'] });
        // Only the issue's own state, cost and id appear, and they are the ones the row carries: the
        // same-pass case needs no second rule, it is the first rule reading a store one write later.
        expect(result.message).toBe(
            refusal(
                'D-33c',
                'a proposal cannot be filed while 1 issue is unresolved — finding_0 (major, unconfirmed) — because a suggestion about a book that still has defects is not what the round is for. An issue holds a proposal down only while it is `unconfirmed`, `confirmed` or `approved`; one the Editor marked `disputed` is not a defect and releases it, exactly as `fixed` or `discarded` does (D-33c).'
            )
        );
        expect(store.findings.list().map((finding) => finding.id)).toEqual(['finding_0']);
    });

    it('refuses the issue that follows a proposal in the same pass, by name (D-33c)', async () => {
        const raised = await call('critic', proposal());

        expect(raised).toMatchObject({ ok: true, data: { id: 'finding_0', kind: 'proposal' } });

        const result = await call('critic', issue());

        expect(result).toMatchObject({ ok: false, refused: 'D-33c', field: 'kind', expected: ['proposal'] });
        // The other direction of the no-mixing rule, and the one the first rule cannot catch: an ISSUE is
        // always filable, so the proposal coming first is what has to be refused — attributed to THIS
        // run through the journal, because §4.10 has no `run_ref` field.
        expect(result.message).toBe(
            refusal(
                'D-33c',
                'this pass already filed finding_0 as `kind: proposal`, and an issue cannot share a review pass with a proposal (D-33c).'
            )
        );
        expect(result).toMatchObject({ proposal_refs: ['finding_0'] });
        expect(result.fix).toBe(
            'this pass filed a proposal; an issue and a proposal cannot share a pass. End the pass; file the issue in your next review'
        );
        expect(store.findings.list().map((finding) => `${finding.id}:${finding.kind}`)).toEqual(['finding_0:proposal']);
    });

    it('refuses the issue after a proposal raised by the same run on a DIFFERENT Story row (D-33c)', async () => {
        // The pass boundary is the RUN, not the target: two calls about two different artifacts are
        // still one pass, and one pass answers one question.
        const raised = await call('reader', proposal({ target_ref: story.id }), 'run_review_1');

        expect(raised.ok).toBe(true);

        const result = await call('reader', issue({ criterion_ref: 'C-7' }), 'run_review_1');

        expect(result).toMatchObject({ ok: false, refused: 'D-33c', proposal_refs: ['finding_0'] });

        // The same issue by a DIFFERENT pass is filable: the rule is about the pass, not about the book.
        const nextPass = await call('reader', issue({ criterion_ref: 'C-7' }), 'run_review_2');

        expect(nextPass).toMatchObject({ ok: true, data: { id: 'finding_1', kind: 'issue' } });
    });

    it('never holds an issue back, however many issues and proposals are already open (D-33c)', async () => {
        seedFinding('issue', 'unconfirmed');
        seedFinding('issue', 'confirmed', 'critical');
        seedFinding('proposal', 'confirmed');

        // Issues are the release valve, so they stay filable over anything: refusing them is how a rule
        // like this one deadlocks a book by refusing the very work that would unlock it.
        const first = await call('critic', issue());
        const second = await call('critic', issue({ title: 'the storm arrives after the relief' }));

        expect(first).toMatchObject({ ok: true, data: { id: 'finding_3', kind: 'issue' } });
        expect(second).toMatchObject({ ok: true, data: { id: 'finding_4', kind: 'issue' } });
    });

    it('releases the proposal the moment every issue reaches `fixed` (D-33c)', async () => {
        seedFinding('issue', 'confirmed');
        seedFinding('issue', 'unconfirmed', 'minor');
        store.findings.list().forEach((row) => {
            const fresh = store.findings.require(row.id);

            store.findings.update(row.id, { state: 'fixed' }, { why: 'seed: the Writer landed the repair' }, [
                { id: row.id, rev: fresh.rev }
            ]);
        });

        const result = await call('critic', proposal());

        expect(result).toMatchObject({ ok: true, data: { id: 'finding_2', kind: 'proposal' } });
    });

    it('releases the proposal the moment every issue reaches `discarded` (D-33c)', async () => {
        seedFinding('issue', 'confirmed');
        const row = store.findings.require('finding_0');

        store.findings.update('finding_0', { state: 'discarded' }, { why: 'seed: the Author declined the claim' }, [
            { id: row.id, rev: row.rev }
        ]);

        const result = await call('critic', proposal());

        expect(result).toMatchObject({ ok: true, data: { id: 'finding_1', kind: 'proposal' } });
    });

    it.each([
        ['unconfirmed', 'finding_0 (major, unconfirmed)'],
        ['confirmed', 'finding_0 (major, confirmed)'],
        ['approved', 'finding_0 (major, approved)']
    ] as const)('an issue in state `%s` still holds every proposal open (D-33c)', async (state, roster) => {
        seedFinding('issue', state);
        const result = await call('critic', proposal());

        // THE HOLDING SET, exactly (`loop/types.ts:ISSUE_HOLDING_STATES`). `approved` counts because
        // approval is the START of the repair, not the end of it (D-34: the approval is what creates the
        // Writer task). Nothing else holds: `fixed` and `discarded` settled the claim, and `disputed` —
        // pinned as the release right below — is the Editor's verdict that there was never a claim to
        // answer, a row the pipeline drives no work for and can never move on its own.
        expect(result).toMatchObject({ ok: false, refused: 'D-33c', open_issues: 1, open_issue_refs: ['finding_0'] });
        expect(result.message).toContain(`— ${roster} —`);
    });

    it('files the proposal over an issue the Editor DISPUTED — a disputed claim is not a defect (D-33c)', async () => {
        // THE DEADLOCK THIS DOCTRINE REMOVES (2026-11-25, the owner's "not blocking — keep flowing"). A
        // `disputed` row drives nothing: no fix task (`loop/status.ts`), no verification seat
        // (`loop/work.ts`'s queue is `unconfirmed`-only), no Author queue row
        // (`records.ts:findingsAwaitingAuthor` wants `confirmed`), and the rail files it under
        // "archived" (`projections.ts`'s open filter). While it counted as open the Critic stayed refused
        // forever over a row nobody could act on, and the UI truthfully showed no open issues.
        seedFinding('issue', 'disputed');

        const result = await call('critic', proposal());

        expect(result).toMatchObject({ ok: true, data: { id: 'finding_1', kind: 'proposal' } });
        expect(store.findings.list().map((finding) => `${finding.id}:${finding.kind}:${finding.state}`)).toEqual([
            'finding_0:issue:disputed',
            'finding_1:proposal:unconfirmed'
        ]);
        // The release does NOT rewrite the verdict: the row stays `disputed` for the audit, and the
        // Author's unguarded approve/discard routes (`api/routes.ts`) remain the overturn valves —
        // decisions the flow takes no part in waiting for.
        expect(store.findings.require('finding_0').state).toBe('disputed');
    });

    it('holds a proposal behind a disputed row ONLY while the row is still answerable (D-33c, the three states)', async () => {
        // THE CONTRAST THAT KEEPS THIS A RULE AND NOT A FREE PASS: the same Story, the same proposal, the
        // issue moved through the three holding states and back to `disputed`. Each holding state refuses
        // with that row named; the dispute releases; re-opening the row (the Author approving a disputed
        // claim back into work) holds it again — so the doctrine is about the STATE, not about the word.
        seedFinding('issue', 'disputed');

        expect(await call('critic', proposal({ title: 'open on the lie' }))).toMatchObject({ ok: true });

        const reopened = store.findings.update(
            'finding_0',
            { state: 'approved', approved_by: 'author' },
            { why: 'seed: the Author overturns the dispute and puts the defect back in work' },
            [{ id: 'finding_0', rev: store.findings.require('finding_0').rev }]
        );

        expect(reopened.state).toBe('approved');
        expect(await call('reader', proposal({ title: 'let the keeper lie first', criterion_ref: 'C-11' }))).toMatchObject({
            ok: false,
            refused: 'D-33c',
            open_issue_refs: ['finding_0']
        });
    });

    it('refuses a proposal approved over an open issue, on `approve` and on `auto` (D-33d)', async () => {
        // The dial covers `major`, so `auto` reaches the approval gate rather than paying D-35's
        // refusal first — which is the whole point: the sweep that approves by cost alone is the funnel
        // this rule closes.
        store.stories.update(story.id, { auto_approve: ['critical', 'major'] }, { why: 'seed: the dial covers major' });
        seedFinding('proposal', 'confirmed');
        seedFinding('issue', 'confirmed');

        for (const decision of ['approve', 'auto']) {
            const result = await approve('finding_0', decision);

            expect(result).toMatchObject({
                ok: false,
                refused: 'D-33d',
                finding_id: 'finding_0',
                kind: 'proposal',
                open_issues: 1,
                open_issue_refs: ['finding_1']
            });
            expect(result.message).toBe(
                refusal(
                    'D-33d',
                    'proposal finding_0 cannot be approved while 1 issue is unresolved — finding_1 (major, confirmed) — because issues are in focus before anything else can be done (D-33d). Only `unconfirmed`, `confirmed` and `approved` issues are in that set: one you marked `disputed` already released this proposal.'
                )
            );
            expect(result.fix).toBe(
                'work the issues first — verify each one (confirm or dispute), approve, fix or discard it — then approve this proposal; or discard it now, which is allowed at any time'
            );
        }

        // Nothing moved: the row is still the Author's queue row it was, not approved work.
        expect(store.findings.require('finding_0').state).toBe('confirmed');
        expect(store.tasks.list()).toEqual([]);
    });

    it('approves a proposal over a DISPUTED issue (D-33d)', async () => {
        // The approval-side half of the same release. A `disputed` row is not work the loop is waiting
        // on: the Editor refused to call it a defect, no fix task and no verification seat ever comes
        // from it, and the Author's unguarded approve/discard routes stay open for overturning it later.
        seedFinding('proposal', 'confirmed');
        seedFinding('issue', 'disputed');

        const result = await approve('finding_0', 'approve');

        expect(result).toMatchObject({
            ok: true,
            data: { id: 'finding_0', state: 'approved', decision: 'approve' }
        });
        // D-34's task still opens on the far side of the gate, and the disputed row is left alone.
        expect(store.tasks.list().map((task) => `${task.kind}:${task.finding_ref}:${task.state}`)).toEqual([
            'fix:finding_0:open'
        ]);
        expect(store.findings.require('finding_1').state).toBe('disputed');
    });

    it('lets the dial decide a proposal over a DISPUTED issue on `auto` (D-33d)', async () => {
        // …and the funnel that deadlocks with nobody clicking it: `auto` is the decision the dial drives,
        // and the same gate answers it. (`loop/findings.test.ts` pins the sweep's own skip.)
        store.stories.update(story.id, { auto_approve: ['critical', 'major'] }, { why: 'seed: the dial covers major' });
        seedFinding('proposal', 'confirmed');
        seedFinding('issue', 'disputed');

        const result = await approve('finding_0', 'auto');

        expect(result).toMatchObject({
            ok: true,
            data: { id: 'finding_0', state: 'approved', approved_by: 'auto', decision: 'auto' }
        });
    });

    it('allows a proposal to be DISCARDED while issues are open (D-33d)', async () => {
        seedFinding('proposal', 'confirmed');
        seedFinding('issue', 'confirmed');

        const result = await approve('finding_0', 'discard');

        // Declining a change is not an approval: it creates no Writer task and it CLOSES the row, so
        // refusing it would strand the proposal in the queue for the rest of the phase.
        expect(result).toMatchObject({ ok: true, data: { id: 'finding_0', state: 'discarded' } });
        expect(store.tasks.list()).toEqual([]);
    });

    it('approves an ISSUE while other issues are open, and the proposal once the issues are fixed (D-33d)', async () => {
        seedFinding('issue', 'confirmed');
        seedFinding('issue', 'confirmed', 'critical');
        seedFinding('proposal', 'confirmed');

        // The defects that unlock a proposal are never themselves held by the rule — that is the
        // deadlock this avoids. A second open issue does not hold the first one's approval.
        expect(await approve('finding_1', 'approve')).toMatchObject({ ok: true, data: { state: 'approved' } });

        // And `approved` is NOT `resolved`: finding_1 is now approved work and still holds the proposal
        // shut, alongside the issue that was never touched.
        const stillBlocked = await approve('finding_2', 'approve');

        expect(stillBlocked).toMatchObject({ ok: false, refused: 'D-33d', open_issue_refs: ['finding_0', 'finding_1'] });

        for (const id of ['finding_0', 'finding_1']) {
            const fresh = store.findings.require(id);

            store.findings.update(id, { state: 'fixed' }, { why: 'seed: the repair landed' }, [
                { id, rev: fresh.rev }
            ]);
        }

        const approved = await approve('finding_2', 'approve');

        expect(approved).toMatchObject({ ok: true, data: { id: 'finding_2', state: 'approved' } });
        // D-34's task still opens on the far side of the gate — the rule sequences approvals, it does
        // not neuter them. `finding_1`'s row is the issue approved at the top of the test.
        expect(store.tasks.list().map((task) => `${task.kind}:${task.finding_ref}`)).toEqual([
            'fix:finding_1',
            'fix:finding_2'
        ]);
    });

    it('refuses a proposal the Editor itself raised, not only a Critic\u2019s (D-33c, D-33d)', async () => {
        seedFinding('issue', 'confirmed');
        const result = await call('editor', proposal());

        // The gate is on the CLAIM, not on the role that files it: an Editor confirming its own proposal
        // over an open defect buys the same Writer round the rule exists to sequence.
        expect(result).toMatchObject({ ok: false, refused: 'D-33c', open_issue_refs: ['finding_0'] });
    });

    it('files a proposal over an issue that was DISCARDED, and over a closed proposal (D-33c)', async () => {
        seedFinding('issue', 'discarded');
        seedFinding('proposal', 'fixed');

        const result = await call('critic', proposal({ title: 'open on the lie instead' }));

        // `fixed` and `discarded` are the only two closers, and they close regardless of their own kind:
        // a closed proposal row is history, not an open claim competing for the same pass.
        expect(result).toMatchObject({ ok: true, data: { id: 'finding_2', kind: 'proposal' } });
    });
});
