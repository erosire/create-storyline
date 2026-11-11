// U-1e / §2 (D-8): the audit has to tell three writers apart — the Author, a dispatched crew run,
// and "the machine, on the Author's instruction" (§8.6's assistant run). Only the run layer knows a
// Work Item's kind, so the flag rides on the SESSION (`RunSession.assistant`) and the pipeline copies
// it into every write's attribution (`tools/context.ts`, `buildAttribution` in ./utilities).
//
// Pinned at the journal, because the journal IS the audit (P11): the attribution object of the row
// the assistant's write produces, exactly, plus the control that a plain crew session still writes
// `assistant: false`.
import { describe, expect, it } from 'vitest';
import type { Chapter, ChapterSection, RoleKind, Story } from '../../shared/types';
import { Store } from '../store/store';
import { createToolRuntime, type RunToolContext, type ToolResult } from './index';
import type { RunSession } from './types';

/** The exact §4.4 section shape; only a `writer`-origin section is writable (D-7). */
const WRITER_SECTION: ChapterSection = { id: 'section_1', text: 'The first written span.', origin: 'writer' };

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
    ) as Story;

    const chapter = store.chapters.create(
        {
            story_id: story.id,
            plotline_ref: 'plotline_1',
            order: 1,
            title: 'Sign off',
            summary: 'The keeper climbs.',
            sections: [WRITER_SECTION],
            state: 'drafting',
            author_locked: false,
            round: 0
        },
        { why: 'seed: chapter created' }
    ) as Chapter;

    return { store, story, chapter };
}

/**
 * One session, built the way `RunExecutor.sessionFor` builds it. `assistant` is the only field that
 * differs from a crew session, because it is the only thing the run layer knows and the tool layer
 * cannot derive.
 */
function sessionFor(storyId: string, assistant: boolean): RunSession {
    return {
        storyId,
        roleKind: 'writer' as RoleKind,
        roleName: 'assistant',
        runId: 'run_1',
        ...(assistant ? { assistant: true } : {})
    };
}

/** One `editChapter` call, and the attribution the journaled write carried. */
async function writeAs(store: Store, story: Story, chapter: Chapter, assistant: boolean): Promise<ToolResult> {
    const runtime = createToolRuntime(store);
    const context: RunToolContext = runtime.createContext(sessionFor(story.id, assistant));

    return runtime.execute(context, 'editChapter', {
        chapter_id: chapter.id,
        section_id: WRITER_SECTION.id,
        content: 'The keeper signs off with the lamp still burning.',
        expects: [{ id: chapter.id, rev: chapter.rev }],
        why: 'the Author asked for the ending to land on the lamp'
    });
}

/** The single chapter-write event's attribution — the audit row §2 is about. */
const attributionOf = (store: Store) => {
    const events = store.journal.filter((event) => event.collection === 'chapters' && event.op === 'update');

    expect(events).toHaveLength(1);

    return events[0].attribution;
};

describe('U-1e — the assistant run writes as the assistant (§2, D-8)', () => {
    it('an assistant session records run_ref, author:false and assistant:true on the row it writes', async () => {
        const { store, story, chapter } = seedWorld();

        const result = await writeAs(store, story, chapter, true);

        expect(result.ok).toBe(true);
        expect(attributionOf(store)).toEqual({
            run_ref: 'run_1',
            author: false, // T-5/P11: an agent write is never the Author's own edit
            assistant: true, // §2's third writer kind: the machine, on the Author's instruction
            why: 'the Author asked for the ending to land on the lamp'
        });
    });

    it('a plain crew session still writes assistant:false — the flag is not a default', async () => {
        const { store, story, chapter } = seedWorld();

        const result = await writeAs(store, story, chapter, false);

        expect(result.ok).toBe(true);
        expect(attributionOf(store)).toEqual({
            run_ref: 'run_1',
            author: false,
            assistant: false,
            why: 'the Author asked for the ending to land on the lamp'
        });
    });
});
