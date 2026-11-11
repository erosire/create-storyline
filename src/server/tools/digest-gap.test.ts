/**
 * U-3a — D-13's `digest_gap` repair path, pinned end to end.
 *
 * D-13's sentence has two halves: "if the Digest is insufficient for a judgment, the run files a
 * `digest_gap` finding and the loop repairs the Digest". Before this fix neither half could be
 * reached:
 *
 *   1. `raiseFinding` resolved EVERY criterion ref against the §4.11 Goal (checker.ts), and no Goal
 *      carries `digest_gap` — it is a §4.6 open-thread ref, not a criterion a crew judges against.
 *      So the call every brief tells the crew to make (`run/brief.ts`: "file a `digest_gap` finding
 *      (D-13)") came back as a T-11 naming error, and the gap could never be filed.
 *   2. Nothing pinned that the builder actually widens the body when such a finding is open, which
 *      is the whole content of "the loop repairs the Digest" in this build.
 *
 * And the refusals that were supposed to route the agent there named a call that does not exist:
 * §8's `createTask` declares no `kind` field (checker.ts's schema — "a model-chosen kind is noise"),
 * so "createTask with kind digest_gap" produced a second refusal. Both halves and the routing text
 * are pinned below with exact values.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultGoal } from '../../shared/criteria';
import type { Chapter, ChapterSection, Digest, Story } from '../../shared/types';
import { DigestBuilder } from '../digest/digest';
import { Store } from '../store/store';
import { createToolRuntime, type RunToolContext, type ToolResult, type ToolRuntime } from './index';
import type { RunSession } from './types';

/** The exact §4.4 section shape; `content` is derived, never stored (D-7). */
const WRITER_SECTION: ChapterSection = { id: 'section_1', text: 'The first written span.', origin: 'writer' };

/**
 * One Story with one plotline and one chapter — the minimum a Digest can be derived from (D-12a),
 * and the same shape `runtime.test.ts` seeds, so the two files read alike.
 */
function seedWorld(): { store: Store; story: Story; chapter: Chapter } {
    const store = Store.empty();
    const story = store.stories.create(
        {
            title: 'The Light Keeper',
            phase: 'chapters',
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
            sections: [WRITER_SECTION],
            state: 'drafting',
            author_locked: false,
            round: 0
        },
        { why: 'seed: chapter created' }
    );

    return { store, story, chapter };
}

/** A checker session — the kind §7 gives `findings: write` to (D-16's triage flow). */
function sessionFor(storyId: string): RunSession {
    return { storyId, roleKind: 'checker', roleName: 'checker_1', runId: 'run_checker' };
}

describe('the digest_gap filing path (U-3a, D-13, D-12a)', () => {
    let store: Store;
    let story: Story;
    let chapter: Chapter;
    let runtime: ToolRuntime;
    let context: RunToolContext;
    let digest: DigestBuilder;

    beforeEach(() => {
        const world = seedWorld();

        store = world.store;
        story = world.story;
        chapter = world.chapter;
        runtime = createToolRuntime(store);
        context = runtime.createContext(sessionFor(story.id));
        digest = new DigestBuilder();
    });

    /** One tool call, built the way the run layer builds it (S-1: one session per run). */
    async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        return runtime.execute(context, name, args);
    }

    /** The filing call D-13 describes, with the fields §8's `raiseFinding` requires. */
    function fileGap(who: RunSession = sessionFor(story.id)): Promise<ToolResult> {
        return runtime.execute(runtime.createContext(who), 'raiseFinding', {
            target_ref: chapter.id,
            criterion_ref: 'digest_gap',
            title: 'The Digest cannot tell which chapters changed',
            evidence: 'readDigest returned a body with no per-chapter contract lines.',
            cost: 'major',
            why: 'The brief is too thin to judge chapter 1 against C-3 (D-13).'
        });
    }

    it('accepts criterion_ref "digest_gap", which is the §4.6 ref and not a Goal criterion (U-3a, D-13)', async () => {
        // The premise of the whole gap: the built-in Goal's list does not contain the id, which is
        // why resolving every ref against it refused the call D-13 asks for.
        expect(defaultGoal(story.id).criteria.map((criterion) => criterion.id)).not.toContain('digest_gap');

        const result = await fileGap();

        expect(result.ok).toBe(true);
        expect(store.findings.list().length).toBe(1);
        // D-16: a filed finding lands `unconfirmed` for triage, and §4.6's open-thread ref is the
        // criterion id the builder reads back.
        expect(store.findings.require('finding_1')).toMatchObject({
            story_id: story.id,
            target_ref: 'chapter_1',
            criterion_ref: 'digest_gap',
            title: 'The Digest cannot tell which chapters changed',
            cost: 'major',
            state: 'unconfirmed'
        });
    });

    it('still refuses an unknown criterion ref naming T-11 — the hole is one named id, not a wildcard (U-3a, T-11)', async () => {
        const result = await call('raiseFinding', {
            target_ref: chapter.id,
            // One character off: the typo case the Goal resolution exists to catch.
            criterion_ref: 'digest_gapp',
            title: 'A typo in the gap ref',
            evidence: 'chapter_1 section_1',
            cost: 'major',
            why: 'Triage.'
        });

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('T-11');
        expect(result.message).toContain('no criterion "digest_gapp"');
        expect(store.findings.list().length).toBe(0);
    });

    it('the open finding is the signal the builder reads: the rebuilt body carries the contract lines (U-3a, D-13, D-12a)', async () => {
        // The compact body, before anyone complains: one line per chapter and no contract detail.
        // `store.commit` returns the journal group, not the callback's value (engine.ts:391 calls it
        // the same way), so the rebuilt row is captured from inside the closure.
        let compact: Digest;

        await store.commit('rebuild_digest', () => {
            compact = digest.rebuild(store, story.id);
        });

        expect(digest.isExpanded(store, story.id)).toBe(false);
        expect(compact!.body.split('\n')[0]).toBe(`digest · ${story.id} · rev 1`);
        expect(compact!.body).toContain('1 · Sign off — The keeper climbs. [1 section(s), drafting]');
        expect(compact!.body).not.toContain('must_happen: He climbs the tower.');

        const filed = await fileGap();

        expect(filed.ok).toBe(true);
        expect(digest.isExpanded(store, story.id)).toBe(true);
        // D-14: the finding's own commit moved the book, so the current Digest is stale and the
        // sweep's rebuild step (loop/engine.ts) runs. This is the mechanical half of "the loop
        // repairs the Digest" — no extra signal is needed once the finding can be filed at all.
        expect(digest.isStale(store, story)).toBe(true);

        let expanded: Digest;

        await store.commit('rebuild_digest', () => {
            expanded = digest.rebuild(store, story.id);
        });

        // §4.8's `rev` is `stories.digest_rev` — the row's own `rev` is the T-4 CAS token of the row
        // the store just minted, which is why the header line and the Story field are the assertions.
        expect(store.stories.require(story.id).digest_rev).toBe(2);
        expect(expanded!.body.split('\n')[0]).toBe(
            `digest · ${story.id} · rev 2 · expanded detail (open digest_gap, D-13)`
        );
        // D-13's actual content: the per-chapter contract a run had to open the book for.
        expect(expanded!.body).toContain('  must_happen: He climbs the tower.');
        expect(expanded!.body).toContain('  must_change: He knows the light is his own fault.');
        // Only the current row is flagged current (D-12a's history), and the widened one is it.
        expect(
            store.digests
                .list()
                .filter((row) => row.current === true)
                .map((row) => row.id)
        ).toEqual([expanded!.id]);
    });

    it('the refusal text names a call that exists: createTask has no kind, so the finding is the route (U-3a, D-12a, D-13)', async () => {
        const createTask = runtime.schemas().find((schema) => schema.function.name === 'createTask');

        // The old refusal told the agent to send a field the tool does not declare, which is how it
        // died in a second refusal. Pinned so the routing text cannot drift back onto it.
        // (`parameters` is an open JSON-Schema document, so the property bag needs a read cast.)
        const taskParameters = createTask?.function.parameters as { properties?: Record<string, unknown> } | undefined;

        expect(taskParameters?.properties?.kind).toBeUndefined();

        const result = await call('updateDigest', {
            body: 'A rewrite the crew is not allowed to make.',
            expects: [{ id: story.id, rev: story.rev }],
            why: 'The Digest missed the fire.'
        });

        expect(result.refused).toBe('D-12a');
        // The §7 row's `refusal_fix` (permissions.ts) is what the permission layer attaches, and
        // `updateDigest`'s own backstop throw now carries the identical sentence.
        expect(result.fix).toBe(
            'raiseFinding with criterion_ref "digest_gap" and the reason the Digest is wrong (D-13)'
        );

        // And the call the refusal now names really is accepted by this same session.
        const retry = await fileGap();

        expect(retry.ok).toBe(true);
        expect(store.findings.require('finding_1').criterion_ref).toBe('digest_gap');
        expect(store.tasks.list().length).toBe(0);
    });

    it('readDigest names the finding, not a task kind, when nothing has been derived yet (U-3a, D-13)', async () => {
        const result = await call('readDigest', {});

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ digest: null, story_id: story.id, stale: true, digest_rev: 0 });
        expect(result.notes).toEqual([
            'No digest has been derived for this Story yet. Work from readSeed, readSummary, readPlotline and readChapter, and raise a digest_gap finding if the absence blocks a review (D-13).'
        ]);
    });
});
