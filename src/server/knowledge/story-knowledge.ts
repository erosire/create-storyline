// The Story's working knowledge: one durable article per directory section.
//
// WHY THIS IS ITS OWN STORE, AND NOT A FIELD ON THE BOOK: the Author asked for a knowledge
// listing that survives the thread and the harness. `store.json` already survives, but it is
// the loop's record; the knowledge base is the reading surface — the thing a human (or a fresh
// crew) browses to remember what the story is. So this module writes through the harness's
// cross-session knowledge engine, the same one the `knowledge` tool uses
// (`@underload/harness` `createKnowledgeEngine` + `loadKnowledgeFileStore`). The bytes live at
// `<storeRoot>/harness/knowledge/`, outside every session, so a killed run, a destroyed
// harness, or a restarted server cannot take the directory with it.
//
// ONE ARTICLE PER SECTION. A Story has eight folders (Summary, Plotlines, Chapters, Cast,
// Continuity, Goal, Ideas, Findings); each folder is one knowledge article and each entry is
// one paragraph. That keeps every article far below the engine's 64-paragraph cap and means a
// chapter edit rewrites one small article instead of the whole story.
//
// THE STORE IS THE SOURCE OF TRUTH; THE KNOWLEDGE BASE IS A PROJECTION. Every commit to the
// book re-derives the affected story's sections. An entry a human (or a crew) edits through
// the `knowledge` tool survives until the store record it mirrors changes again — at which
// point the newly committed book wins, which is the only rule that keeps the directory honest.
// A section with no records still gets a placeholder so the folder is visible before its
// artifacts exist (an empty Summary is information, not a missing folder).
import path from 'node:path';
import { createKnowledgeEngine, loadKnowledgeFileStore, type KnowledgeArticle, type KnowledgeEngine, type KnowledgeStore } from '@underload/harness';
import { chapterContent } from '../../shared/chapter';
import type {
    CastMember,
    Chapter,
    Criterion,
    Finding,
    Idea,
    LedgerEntry,
    Plotline,
    Story,
    Summary
} from '../../shared/types';
import type { Store } from '../store/store';

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

/** The folders every Story carries, in reading order. `empty` is the placeholder's sentence. */
export const STORY_SECTIONS = [
    {
        key: 'summary',
        title: 'Summary',
        empty: 'The Summary has not been written yet — the crew writes it in phase ①.'
    },
    {
        key: 'plotlines',
        title: 'Plotlines',
        empty: 'No plotlines yet — phase ② locks one contract per chapter.'
    },
    {
        key: 'chapters',
        title: 'Chapters',
        empty: 'No chapters yet — phase ③ turns the plotlines into prose.'
    },
    {
        key: 'cast',
        title: 'Characters',
        empty: 'No cast members yet — want, need, arc, and the state they carry now.'
    },
    {
        key: 'continuity',
        title: 'Continuity',
        empty: 'No continuity facts yet — setups, payoffs, and the facts a change must respect.'
    },
    { key: 'goal', title: 'Goal', empty: 'No criteria yet — the Goal is the bar the loop measures against.' },
    { key: 'ideas', title: 'Ideas', empty: 'The Ideas tray is empty for this phase.' },
    { key: 'findings', title: 'Findings', empty: 'No findings are open on this story.' }
] as const;

export type StorySectionKey = (typeof STORY_SECTIONS)[number]['key'];

/** One paragraph of a section, as the browser renders it. */
export interface StoryKnowledgeEntry {
    key: string;
    title: string;
    body: string;
    tags: string[];
}

/** One folder, plus the article that owns it. */
export interface StoryKnowledgeSection {
    key: StorySectionKey;
    title: string;
    article_id: string | null;
    updated_at: string | null;
    entries: StoryKnowledgeEntry[];
}

/** `GET /stories/:id/knowledge` — the whole directory in one read. */
export interface StoryKnowledgeTree {
    story_id: string;
    story_title: string;
    /** The article ids, one per folder; `null` when the folder has not been materialised yet. */
    sections: StoryKnowledgeSection[];
    /** True when no section article could be found or created (the knowledge store is unavailable). */
    degraded: boolean;
}

// ---------------------------------------------------------------------------
// Bound helpers
// ---------------------------------------------------------------------------

const STORY_TAG_PREFIX = 'story:';
const SECTION_TAG_PREFIX = 'section:';
const ENTRY_TAG_PREFIX = 'entry:';
const KNOWLEDGE_KIND_TAG = 'storyline-knowledge';
const PLACEHOLDER_TAG = 'placeholder';
const MAX_ENTRIES_PER_SECTION = 63;

/**
 * The harness knowledge engine caps one paragraph at 4000 characters. Leave room for the title
 * and the truncation sentence, and never let a chapter body be silently dropped by a refusal.
 */
const MAX_ENTRY_TEXT = 3_900;

const fitText = (text: string): string => {
    if (text.length <= MAX_ENTRY_TEXT) return text;

    const marker = '\n\n… truncated — read the full artifact in the Story view.';

    return `${text.slice(0, MAX_ENTRY_TEXT - marker.length).trimEnd()}${marker}`;
};

const storyTag = (storyId: string): string => `${STORY_TAG_PREFIX}${storyId}`;
const sectionTag = (section: StorySectionKey): string => `${SECTION_TAG_PREFIX}${section}`;
const entryTag = (key: string): string => `${ENTRY_TAG_PREFIX}${key}`;

function entryTags(storyId: string, section: StorySectionKey, key: string): string[] {
    return [
        storyTag(storyId),
        sectionTag(section),
        entryTag(key),
        ...(key.endsWith(':empty') ? [PLACEHOLDER_TAG] : [])
    ];
}

/** The first line is the entry title; a blank line separates it from the body. */
const textOf = (entry: { title: string; body: string }): string =>
    fitText(entry.body.trim().length === 0 ? entry.title : `${entry.title}\n\n${entry.body}`);

const splitText = (text: string): { title: string; body: string } => {
    const boundary = text.indexOf('\n\n');

    if (boundary < 0) return { title: text.trim(), body: '' };

    return { title: text.slice(0, boundary).trim(), body: text.slice(boundary + 2) };
};

/** One desired entry; `key` is the stable identity across syncs. */
interface DesiredEntry {
    key: string;
    title: string;
    body: string;
}

const line = (label: string, value: string | number | boolean | undefined | null): string => {
    if (value === undefined || value === null || value === '') return '';

    return `${label}: ${String(value)}`;
};

const paragraph = (...lines: string[]): string =>
    lines
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0)
        .join('\n');

const placeholder = (section: (typeof STORY_SECTIONS)[number]): DesiredEntry => ({
    key: `${section.key}:empty`,
    title: section.title,
    body: section.empty
});

const byOrder = <T extends { order: number }>(left: T, right: T): number => left.order - right.order;

// ---------------------------------------------------------------------------
// The projection: store records -> the directory's entries
// ---------------------------------------------------------------------------

function summaryEntries(summary: Summary | null | undefined): DesiredEntry[] {
    if (!summary) return [];

    return [
        {
            key: 'summary',
            title: 'Overview',
            body: paragraph(
                line('Chapters', summary.chapter_count),
                line('Premise', summary.premise),
                line('Promise', summary.promise),
                line('Theme', summary.theme),
                line('Tone', summary.tone),
                line('Ending', summary.ending),
                line('World rules', summary.world_rules),
                summary.locked ? 'Locked: the Author has signed this phase.' : 'Draft: still being worked.'
            )
        }
    ];
}

function plotlineEntries(plotlines: Plotline[]): DesiredEntry[] {
    return plotlines.sort(byOrder).map((plotline) => ({
        key: `plotline:${plotline.id}`,
        title: `Chapter ${plotline.order} · ${plotline.heading || plotline.id}`,
        body: paragraph(
            line('Must happen', plotline.must_happen),
            line('Must change', plotline.must_change),
            line('POV', plotline.pov),
            line('Setups', plotline.setups),
            line('Payoffs', plotline.payoffs),
            line('Aligned with the Summary', plotline.aligned ? 'yes' : 'not yet'),
            line('Needs recheck', plotline.needs_recheck ? 'yes' : 'no'),
            plotline.contract_locked ? 'Locked contract: agents propose, they do not overwrite.' : ''
        )
    }));
}

function chapterEntries(chapters: Chapter[]): DesiredEntry[] {
    return chapters.sort(byOrder).map((chapter) => {
        const prose = chapterContent(chapter);
        const sections = chapter.sections
            .map((section) => {
                const label = `${section.id} [${section.origin}]`;

                return section.text.trim().length === 0 ? '' : `— ${label}\n${section.text}`;
            })
            .filter((section) => section.length > 0)
            .join('\n\n');

        return {
            key: `chapter:${chapter.id}`,
            title: `Chapter ${chapter.order} · ${chapter.title}`,
            body: paragraph(
                line('State', chapter.state),
                line('Summary', chapter.summary),
                line('Score', chapter.last_score),
                line('Round', chapter.round),
                line('Revision', chapter.current_revision),
                chapter.author_locked ? 'Author-locked: agents propose a change, never write it.' : '',
                sections || (prose.trim().length > 0 ? prose : 'No prose yet.')
            )
        };
    });
}

function castEntries(cast: CastMember[]): DesiredEntry[] {
    return cast.map((member) => ({
        key: `cast:${member.id}`,
        title: member.name,
        body: paragraph(
            line('Wants', member.want),
            line('Needs', member.need),
            line('Arc', member.arc),
            line('Voice', member.voice),
            line('State now', member.state_now),
            line('Traits', member.traits),
            line('Gender', member.gender)
        )
    }));
}

function continuityEntries(ledger: LedgerEntry[]): DesiredEntry[] {
    return ledger.map((entry) => ({
        key: `ledger:${entry.id}`,
        title: `${entry.kind} · ${entry.subject}`,
        body: paragraph(
            line('Detail', entry.detail),
            line('Chapter', entry.chapter_ref),
            line('Status', entry.status),
            line('Fingerprint', entry.fingerprint)
        )
    }));
}

function goalEntries(criteria: Criterion[], thresholdSoft: number | undefined): DesiredEntry[] {
    if (criteria.length === 0) return [];

    return [
        {
            key: 'goal',
            title: 'Goal',
            body: paragraph(
                line('Soft threshold', thresholdSoft),
                line('Criteria', criteria.length),
                'Each criterion below is a pass/fail question, never a score.'
            )
        },
        ...criteria.map((criterion) => ({
            key: `criterion:${criterion.id}`,
            title: `${criterion.id} · ${criterion.label}`,
            body: paragraph(
                line('Question', criterion.question),
                line('Checker', criterion.checker),
                line('Hard', criterion.hard ? 'yes' : 'no'),
                line('Fix hint', criterion.fix_hint)
            )
        }))
    ];
}

function ideaEntries(ideas: Idea[]): DesiredEntry[] {
    return ideas.map((idea) => ({
        key: `idea:${idea.id}`,
        title: `${idea.kind} · ${idea.author}`,
        body: paragraph(
            line('State', idea.state),
            line('Phase', idea.phase),
            line('Unit', idea.unit_ref),
            idea.body,
            idea.verification
                ? `Verified: ${idea.verification.verdict} — ${idea.verification.evidence}`
                : 'Not yet verified by an Editor.',
            ...idea.sources.map((source) => `Source: ${source.url_or_title} — ${source.claim}`)
        )
    }));
}

function findingEntries(findings: Finding[]): DesiredEntry[] {
    return findings.map((finding) => ({
        key: `finding:${finding.id}`,
        title: `${finding.cost} · ${finding.title}`,
        body: paragraph(
            line('State', finding.state),
            line('Target', finding.target_ref),
            line('Criterion', finding.criterion_ref),
            line('Detail', finding.detail),
            line('Evidence', finding.evidence),
            line('Seen', finding.seen_count)
        )
    }));
}

function desiredEntries(store: Store, story: Story, section: StorySectionKey): DesiredEntry[] {
    const cap = (entries: DesiredEntry[]): DesiredEntry[] =>
        entries.length <= MAX_ENTRIES_PER_SECTION
            ? entries
            : [
                  ...entries.slice(0, MAX_ENTRIES_PER_SECTION - 1),
                  {
                      key: `${section}:overflow`,
                      title: 'More…',
                      body: `${entries.length - (MAX_ENTRIES_PER_SECTION - 1)} more entries are in the book; the knowledge article caps one section at ${MAX_ENTRIES_PER_SECTION} paragraphs.`
                  }
              ];

    if (section === 'summary') {
        return cap(summaryEntries(store.summaries.list().find((row) => row.story_id === story.id)));
    }

    if (section === 'plotlines') {
        return cap(plotlineEntries(store.plotlines.list().filter((row) => row.story_id === story.id)));
    }

    if (section === 'chapters') {
        return cap(chapterEntries(store.chapters.list().filter((row) => row.story_id === story.id)));
    }

    if (section === 'cast') {
        return cap(castEntries(store.cast.list().filter((row) => row.story_id === story.id)));
    }

    if (section === 'continuity') {
        return cap(continuityEntries(store.ledger.list().filter((row) => row.story_id === story.id)));
    }

    if (section === 'goal') {
        const goal = store.goals.list().find((row) => row.story_id === story.id);

        return cap(goalEntries(goal?.criteria ?? [], goal?.threshold_soft));
    }

    if (section === 'ideas') {
        return cap(ideaEntries(store.ideas.list().filter((row) => row.story_id === story.id)));
    }

    return cap(
        findingEntries(
            store.findings
                .list()
                .filter((row) => row.story_id === story.id && row.state !== 'fixed' && row.state !== 'discarded')
        )
    );
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** The one paragraph tag that identifies a desired entry, or undefined for a foreign paragraph. */
const entryKeyOf = (paragraphTags: string[] | undefined): string | undefined => {
    const tag = paragraphTags?.find((candidate) => candidate.startsWith(ENTRY_TAG_PREFIX));

    return tag === undefined ? undefined : tag.slice(ENTRY_TAG_PREFIX.length);
};

/**
 * The knowledge projection. Built over the book and the knowledge engine; a bare engine means
 * an in-memory store (tests and `Store.empty()`), a loaded file store means the bytes survive a
 * restart.
 */
export class StoryKnowledge {
    private readonly store: Store;
    private readonly engine: KnowledgeEngine;
    private readonly durable: KnowledgeStore | null;
    private readonly unsubscribe: () => void;
    private scheduled = false;
    private closed = false;

    private constructor(store: Store, engine: KnowledgeEngine, durable: KnowledgeStore | null) {
        this.store = store;
        this.engine = engine;
        this.durable = durable;
        this.unsubscribe = store.onCommit(() => this.scheduleSync());
    }

    /** A knowledge base for a run that leaves no book behind (tests, `Store.empty()`). */
    static memory(store: Store): StoryKnowledge {
        return new StoryKnowledge(store, createKnowledgeEngine(), null);
    }

    /**
     * The real thing. `storeRoot` is the book's root; the file store appends
     * `<root>/harness/knowledge/` itself, which is the harness-wide convention. A null root is
     * the documented in-memory run and therefore an in-memory knowledge base too — the caller
     * asked for a run that leaves nothing behind.
     */
    static async open(store: Store, storeRoot: string | null): Promise<StoryKnowledge> {
        if (storeRoot === null) return StoryKnowledge.memory(store);

        const durable = await loadKnowledgeFileStore({ root: path.resolve(storeRoot) });
        const knowledge = new StoryKnowledge(store, durable.engine, durable);

        knowledge.syncAll();
        await knowledge.flush();

        return knowledge;
    }

    /** Where the durable files live, when there are any (the server banner and a test read it). */
    get directory(): string | null {
        return this.durable?.directory ?? null;
    }

    /** The engine, exposed for a host that wants to use the same base with a harness. */
    get knowledgeEngine(): KnowledgeEngine {
        return this.engine;
    }

    /** Every story's directory, re-derived now. Used by the boot and by a manual refresh. */
    syncAll(): void {
        if (this.closed) return;

        for (const story of this.store.stories.list()) {
            this.syncStory(story.id);
        }
    }

    /** Re-derive one Story's eight articles. Safe to call on every read. */
    syncStory(storyId: string): void {
        if (this.closed) return;

        const story = this.store.stories.get(storyId);

        if (story === undefined) return;

        for (const section of STORY_SECTIONS) {
            try {
                this.syncSection(story, section.key);
            } catch (error) {
                // A knowledge write is a projection, never the book: a full disk or a rejected
                // article must not fail the commit that produced it. The route reports the
                // section as missing and the next read tries again.
                console.warn(
                    `story knowledge: ${section.key} for ${storyId} could not be written — ${messageOf(error)}`
                );
            }
        }
    }

    /** The browser's read. Always re-derives first, so a commit that raced this request is included. */
    tree(storyId: string): StoryKnowledgeTree | null {
        if (this.closed) return null;

        const story = this.store.stories.get(storyId);

        if (story === undefined) return null;
        this.syncStory(storyId);

        return this.readTree(story);
    }

    /** Await durability (the file layer's barrier). A null store is a zero-cost no-op. */
    async flush(): Promise<void> {
        if (this.durable !== null) await this.durable.flush();
    }

    /** Stop listening and flush whatever the last commit produced. */
    async close(): Promise<void> {
        if (this.closed) return;

        this.closed = true;
        this.unsubscribe();

        if (this.durable !== null) {
            await this.durable.dispose();
        }
    }

    // -- internals -----------------------------------------------------------------

    private scheduleSync(): void {
        if (this.scheduled) return;

        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            this.syncAll();
        });
    }

    private syncSection(story: Story, section: StorySectionKey): void {
        const spec = STORY_SECTIONS.find((candidate) => candidate.key === section);

        if (spec === undefined) return;

        const desired = desiredEntries(this.store, story, section);
        const entries = desired.length > 0 ? desired : [placeholder(spec)];
        const title = `${story.title} — ${spec.title}`.slice(0, 200);
        const tags = [storyTag(story.id), sectionTag(section), KNOWLEDGE_KIND_TAG];
        const article = this.articleFor(story.id, section);

        if (article === null) {
            this.engine.execute({
                verb: 'create',
                title,
                tags,
                content: entries.map((entry) => ({
                    text: textOf(entry),
                    tags: entryTags(story.id, section, entry.key)
                }))
            });
            return;
        }

        const existingByKey = new Map<string, { id: string; text: string; tags?: string[] }>();

        for (const paragraph of article.content) {
            const key = entryKeyOf(paragraph.tags);

            if (key !== undefined) existingByKey.set(key, paragraph);
        }

        const setParagraphs: Array<{ id: string; text: string; tags: string[] }> = [];
        const addContent: Array<{ text: string; tags: string[] }> = [];
        const keep = new Set<string>();

        for (const entry of entries) {
            keep.add(entry.key);

            const text = textOf(entry);
            const paragraphTags = entryTags(story.id, section, entry.key);
            const existing = existingByKey.get(entry.key);

            if (existing === undefined) {
                addContent.push({ text, tags: paragraphTags });
            } else if (existing.text !== text || !sameTags(existing.tags, paragraphTags)) {
                setParagraphs.push({ id: existing.id, text, tags: paragraphTags });
            }
        }

        const removeParagraphs = article.content
            .filter((paragraph) => {
                const key = entryKeyOf(paragraph.tags);

                return key !== undefined && !keep.has(key);
            })
            .map((paragraph) => paragraph.id);

        const articleTags = article.tags;
        const missingTags = tags.filter((tag) => !articleTags.includes(tag));
        const titleChanged = article.title !== title;

        if (
            !titleChanged &&
            missingTags.length === 0 &&
            setParagraphs.length === 0 &&
            addContent.length === 0 &&
            removeParagraphs.length === 0
        ) {
            return;
        }

        this.engine.execute({
            verb: 'modify',
            id: article.id,
            ...(titleChanged ? { title } : {}),
            ...(missingTags.length > 0 ? { addTags: missingTags } : {}),
            ...(setParagraphs.length > 0 ? { setParagraphs } : {}),
            ...(addContent.length > 0 ? { addContent } : {}),
            ...(removeParagraphs.length > 0 ? { removeParagraphs } : {})
        });
    }

    private articleFor(storyId: string, section: StorySectionKey): KnowledgeArticle | null {
        const state = this.engine.snapshot();
        const found = state.articles.find(
            (article) => article.tags.includes(storyTag(storyId)) && article.tags.includes(sectionTag(section))
        );

        return found ?? null;
    }

    private readTree(story: Story): StoryKnowledgeTree {
        const state = this.engine.snapshot();
        let degraded = false;
        const sections: StoryKnowledgeSection[] = [];

        for (const spec of STORY_SECTIONS) {
            const article = state.articles.find(
                (candidate) =>
                    candidate.tags.includes(storyTag(story.id)) && candidate.tags.includes(sectionTag(spec.key))
            );

            if (article === undefined) {
                degraded = true;
                sections.push({
                    key: spec.key,
                    title: spec.title,
                    article_id: null,
                    updated_at: null,
                    entries: [
                        {
                            key: `${spec.key}:empty`,
                            title: spec.title,
                            body: spec.empty,
                            tags: [PLACEHOLDER_TAG]
                        }
                    ]
                });
                continue;
            }

            sections.push({
                key: spec.key,
                title: spec.title,
                article_id: article.id,
                updated_at: article.updatedAt,
                entries: article.content.map((paragraph) => {
                    const { title, body } = splitText(paragraph.text);
                    const tags = paragraph.tags ?? [];
                    const key = entryKeyOf(paragraph.tags) ?? paragraph.id;

                    return { key, title: title || spec.title, body, tags };
                })
            });
        }

        return { story_id: story.id, story_title: story.title, sections, degraded };
    }
}

function sameTags(left: string[] | undefined, right: string[]): boolean {
    if (left === undefined || left.length !== right.length) return false;

    return left.every((tag, index) => tag === right[index]);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
