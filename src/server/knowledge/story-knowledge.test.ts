// The Story knowledge projection: the directory the browser reads, and the durability the
// Author asked for (a destroyed session must not take the knowledge with it).
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../store/store';
import { StoryKnowledge } from './story-knowledge';

const attribution = { author: true, why: 'fixture: a book is made of records (P1)' };

function seedStory(store: Store) {
    const story = store.stories.create(
        {
            title: 'Hollow Sea',
            phase: 'chapters',
            idea: 'a disgraced cartographer must map the sea that ate her fleet, and the sea remembers her name',
            summary_locked: true,
            plotlines_locked: true,
            pending_kind: 'none',
            status: 'ready',
            trend: 'improving',
            auto_approve: ['critical', 'major'],
            author_stop: false,
            digest_rev: 0,
            template_refs: [],
            chapter_deps: {}
        },
        attribution
    );

    store.summaries.create(
        {
            story_id: story.id,
            chapter_count: 2,
            premise: 'A cartographer maps a sea that remembers the fleet it swallowed.',
            theme: 'the map is not the territory, and the territory remembers',
            locked: true
        },
        attribution
    );

    store.plotlines.create(
        {
            story_id: story.id,
            order: 1,
            heading: 'The sounding line',
            must_happen: 'She sounds a trench that is not on any chart.',
            must_change: 'She learns the sea is answering her.',
            contract_locked: true,
            aligned: true,
            needs_recheck: false
        },
        attribution
    );

    store.chapters.create(
        {
            story_id: story.id,
            order: 1,
            title: 'First Sounding',
            summary: 'The fleet is gone; the chart is not.',
            sections: [
                {
                    id: 'section_1_1',
                    text: 'The rope went down and did not come back.',
                    origin: 'writer'
                }
            ],
            state: 'done',
            author_locked: false,
            round: 1,
            last_score: '2/3'
        },
        attribution
    );

    store.chapters.create(
        {
            story_id: story.id,
            order: 2,
            title: 'Long Sounding',
            sections: [{ id: 'section_2_1', text: 'wave '.repeat(2_000), origin: 'writer' }],
            state: 'in_review',
            author_locked: false,
            round: 1
        },
        attribution
    );

    store.cast.create(
        {
            story_id: story.id,
            name: 'Ilsa Vane',
            want: 'a chart that is true',
            need: 'to be forgiven by the sea',
            arc: 'cartographer → witness',
            state_now: 'alone on a borrowed boat'
        },
        attribution
    );

    store.goals.create(
        {
            story_id: story.id,
            title: 'the book as the Author wants it',
            threshold_soft: 2,
            criteria: [
                {
                    id: 'C-0',
                    label: 'the declared chapter count is met',
                    question: 'Does the chapter set match the declared count?',
                    checker: 'code',
                    hard: true,
                    fix_hint: 'Write the missing chapters.'
                }
            ],
            flat_rounds: 4,
            regress_tolerance: 2
        },
        attribution
    );

    return story;
}

describe('StoryKnowledge — the durable directory', () => {
    it('projects the book into the nine folders without recomputing anything client-side', () => {
        const store = Store.empty();
        const story = seedStory(store);
        const knowledge = StoryKnowledge.memory(store);

        const tree = knowledge.tree(story.id);

        expect(tree).not.toBeNull();
        expect(tree?.sections.map((section) => section.key)).toEqual([
            'research',
            'summary',
            'plotlines',
            'chapters',
            'cast',
            'continuity',
            'goal',
            'ideas',
            'findings'
        ]);
        expect(tree?.degraded).toBe(false);

        const summary = tree?.sections.find((section) => section.key === 'summary');
        expect(summary?.entries[0]?.title).toBe('Overview');
        expect(summary?.entries[0]?.body).toContain('A cartographer maps a sea');

        const chapters = tree?.sections.find((section) => section.key === 'chapters');
        expect(chapters?.entries[0]?.title).toBe('Chapter 1 · First Sounding');
        expect(chapters?.entries[0]?.body).toContain('The rope went down');

        // The engine caps one paragraph at 4000 characters; a long chapter is clipped with a
        // sentence that names where the full prose still lives, never refused by the store.
        const long = chapters?.entries.find((entry) => entry.title.includes('Long Sounding'));
        expect(long?.body.length).toBeLessThan(3_950);
        expect(long?.body).toContain('truncated');

        const cast = tree?.sections.find((section) => section.key === 'cast');
        expect(cast?.entries[0]?.title).toBe('Ilsa Vane');

        // An empty folder is still a folder: the shape of a story is visible before its prose.
        const ideas = tree?.sections.find((section) => section.key === 'ideas');
        expect(ideas?.entries[0]?.tags).toContain('placeholder');
        expect(ideas?.entries[0]?.body).toContain('Ideas tray is empty');

        // §10 / §3.2 — the research folder states its absence on a Story nobody has researched.
        const research = tree?.sections.find((section) => section.key === 'research');
        expect(research?.entries).toEqual([
            {
                key: 'research:empty',
                title: 'Research',
                body: 'No research yet — the Researcher gathers the facts, places and sources the book depends on in phase ①.',
                tags: ['story:story_0', 'section:research', 'entry:research:empty', 'placeholder']
            }
        ]);
    });

    it('survives a closed knowledge handle: a second store reads the same articles from disk', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'storyline-knowledge-'));

        try {
            const store = Store.empty();
            const story = seedStory(store);
            const first = await StoryKnowledge.open(store, root);

            expect(first.directory).not.toBeNull();
            expect(first.tree(story.id)?.sections.find((section) => section.key === 'summary')).toBeTruthy();
            await first.flush();
            await first.close();

            // The durable files are the harness's own layout: `<root>/harness/knowledge/`.
            const index = path.join(root, 'harness', 'knowledge', 'index.json');
            expect((await stat(index)).isFile()).toBe(true);

            // A fresh engine over the same root sees the articles even though the first handle
            // (and the book it was projecting) is gone.
            const reopened = await StoryKnowledge.open(Store.empty(), root);
            const articles = reopened.knowledgeEngine.snapshot().articles;

            // Nine articles: the eight §4 surfaces plus phase ①'s research mirror.
            expect(articles).toHaveLength(9);
            expect(articles.some((article) => article.title === 'Hollow Sea — Summary')).toBe(true);
            expect(articles.some((article) => article.title === 'Hollow Sea — Chapters')).toBe(true);

            await reopened.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// §10 / §3.2 — the research mirror (phase ①'s Researcher artifact)
// ---------------------------------------------------------------------------

/** One `knowledge` row in the shape the Researcher's `writeKnowledge` tool lands (§3.2). */
function seedKnowledge(
    store: Store,
    storyId: string,
    entry: {
        importance: 'critical' | 'high' | 'normal' | 'low';
        kind: 'fact' | 'world_rule' | 'tech' | 'period' | 'place' | 'person' | 'other';
        topic: string;
        claim: string;
        detail?: string;
        source?: string;
    }
) {
    return store.knowledge.create(
        {
            story_id: storyId,
            kind: entry.kind,
            topic: entry.topic,
            claim: entry.claim,
            ...(entry.detail === undefined ? {} : { detail: entry.detail }),
            importance: entry.importance,
            // T-10: a source backs ONE named claim — so the fixture cites the entry's own claim.
            sources:
                entry.source === undefined
                    ? []
                    : [{ url_or_title: entry.source, claim: entry.claim, accessed_at: '2026-11-22T09:00:00.000Z' }],
            fingerprint: `fp-${entry.topic.replace(/\s+/g, '-')}`,
            seen_count: 1,
            author: 'researcher'
        },
        attribution
    );
}

describe('StoryKnowledge — the research mirror (phase ①, §3.2/§10)', () => {
    it('mirrors the knowledge rows as one paragraph per entry, importance-sorted, with detail and source', () => {
        const store = Store.empty();
        const story = seedStory(store);

        // Deliberately unsorted: the section sorts by importance (critical → high → normal → low),
        // then by id — never by insertion order.
        seedKnowledge(store, story.id, {
            importance: 'normal',
            kind: 'place',
            topic: 'the tide road',
            claim: 'The tide road floods at dusk.',
            source: 'Tide Survey'
        });
        seedKnowledge(store, story.id, {
            importance: 'critical',
            kind: 'world_rule',
            topic: 'the lamp remembers',
            claim: 'The lamp keeps every keeper name.',
            detail: 'The log outlives the keeper.',
            source: 'Keeper Codex'
        });
        seedKnowledge(store, story.id, {
            importance: 'high',
            kind: 'fact',
            topic: 'the harbour bell',
            claim: 'The bell rings a name before a drowning.'
        });
        seedKnowledge(store, story.id, {
            importance: 'high',
            kind: 'tech',
            topic: 'chart ink',
            claim: 'Chart ink fades in salt water.',
            detail: 'Ships carry a waxed copy.',
            source: 'Chandlery Note'
        });

        const research = StoryKnowledge.memory(store)
            .tree(story.id)
            ?.sections.find((section) => section.key === 'research');

        expect(research?.title).toBe('Research');
        expect(research?.entries).toEqual([
            {
                key: 'knowledge:knowledge_entry_1',
                title: '[critical · world_rule] the lamp remembers',
                body: 'The lamp keeps every keeper name. — The log outlives the keeper. (source: Keeper Codex)',
                tags: ['story:story_0', 'section:research', 'entry:knowledge:knowledge_entry_1']
            },
            {
                // No detail and no source: the entry is ONE line, not a paragraph padded with blanks.
                key: 'knowledge:knowledge_entry_2',
                title: '[high · fact] the harbour bell',
                body: 'The bell rings a name before a drowning.',
                tags: ['story:story_0', 'section:research', 'entry:knowledge:knowledge_entry_2']
            },
            {
                key: 'knowledge:knowledge_entry_3',
                title: '[high · tech] chart ink',
                body: 'Chart ink fades in salt water. — Ships carry a waxed copy. (source: Chandlery Note)',
                tags: ['story:story_0', 'section:research', 'entry:knowledge:knowledge_entry_3']
            },
            {
                key: 'knowledge:knowledge_entry_0',
                title: '[normal · place] the tide road',
                body: 'The tide road floods at dusk. (source: Tide Survey)',
                tags: ['story:story_0', 'section:research', 'entry:knowledge:knowledge_entry_0']
            }
        ]);
    });

    it('caps the section at thirty entries with a trailing count, like every other folder', () => {
        const store = Store.empty();
        const story = seedStory(store);

        for (let index = 1; index <= 32; index += 1) {
            seedKnowledge(store, story.id, {
                importance: 'low',
                kind: 'fact',
                topic: `fact ${index}`,
                claim: `Claim ${index} is load-bearing.`
            });
        }

        const research = StoryKnowledge.memory(store)
            .tree(story.id)
            ?.sections.find((section) => section.key === 'research');

        expect(research?.entries).toHaveLength(30);
        // The tie-break is CODE-UNIT order on the id (`knowledge/story-knowledge.ts:byCodeUnit`, chosen
        // over `localeCompare` because ICU collation depends on the host's locale data and these bytes are
        // the durable article). Code-unit order puts `..._10` before `..._2`, which is NOT numeric order.
        // Spelled out, not re-sorted here, so the test pins the order the sync writes instead of
        // reproducing its comparator.
        expect(research?.entries.slice(0, 29).map((entry) => entry.key)).toEqual([
            'knowledge:knowledge_entry_0',
            'knowledge:knowledge_entry_1',
            'knowledge:knowledge_entry_10',
            'knowledge:knowledge_entry_11',
            'knowledge:knowledge_entry_12',
            'knowledge:knowledge_entry_13',
            'knowledge:knowledge_entry_14',
            'knowledge:knowledge_entry_15',
            'knowledge:knowledge_entry_16',
            'knowledge:knowledge_entry_17',
            'knowledge:knowledge_entry_18',
            'knowledge:knowledge_entry_19',
            'knowledge:knowledge_entry_2',
            'knowledge:knowledge_entry_20',
            'knowledge:knowledge_entry_21',
            'knowledge:knowledge_entry_22',
            'knowledge:knowledge_entry_23',
            'knowledge:knowledge_entry_24',
            'knowledge:knowledge_entry_25',
            'knowledge:knowledge_entry_26',
            'knowledge:knowledge_entry_27',
            'knowledge:knowledge_entry_28',
            'knowledge:knowledge_entry_29',
            'knowledge:knowledge_entry_3',
            'knowledge:knowledge_entry_30',
            'knowledge:knowledge_entry_31',
            'knowledge:knowledge_entry_4',
            'knowledge:knowledge_entry_5',
            'knowledge:knowledge_entry_6'
        ]);
        expect(research?.entries[29]).toEqual({
            key: 'research:overflow',
            title: 'More…',
            body: '3 more entries are in the book; the knowledge article caps one section at 30 paragraphs.',
            tags: ['story:story_0', 'section:research', 'entry:research:overflow']
        });
    });
});

describe('StoryKnowledge — the finding card names its claim type (T5, D-33b)', () => {
    it('prints the Kind line on a proposal only, and leaves a defect card as it was', () => {
        const store = Store.empty();
        const story = seedStory(store);

        // A PROPOSAL. The directory is what a crew reads before it decides anything, and a card that
        // does not say "proposal" gets weighed by the defect's admissibility rule — the exact mistake
        // the `proposal` kind exists to stop.
        store.findings.create(
            {
                story_id: story.id,
                target_ref: 'summary_0',
                criterion_ref: 'C-14',
                title: 'let the keeper lie first',
                detail: 'opening on the lie gives chapter 2 its tension',
                evidence: 'section_1: "he told them the truth"',
                cost: 'major',
                kind: 'proposal',
                fingerprint: 'C-14|summary_0|improvement',
                state: 'approved',
                seen_count: 2
            },
            attribution
        );
        // The default NAMED on the row, and a row written BEFORE the field existed. Both are `issue`,
        // and neither may gain a line: the card byte-matches what a pre-T5 sync wrote, so a re-sync
        // over legacy rows changes nothing.
        store.findings.create(
            {
                story_id: story.id,
                target_ref: 'summary_0',
                criterion_ref: 'C-14',
                title: 'the ending does not pay the promise',
                detail: 'nothing in the ending answers the promise',
                evidence: 'ending: she floods it',
                cost: 'major',
                kind: 'issue',
                fingerprint: 'C-14|summary_0|issue',
                state: 'confirmed',
                seen_count: 1
            },
            attribution
        );
        store.findings.create(
            {
                story_id: story.id,
                target_ref: 'chapter_0',
                criterion_ref: 'C-9',
                title: 'the 1911 map is never paid off',
                detail: 'chapter_1 sec_1 mentions the map; nothing answers it',
                evidence: 'chapter_1 sec_1',
                cost: 'minor',
                fingerprint: 'C-9|chapter_0',
                state: 'unconfirmed',
                seen_count: 1
            },
            attribution
        );

        const findings = StoryKnowledge.memory(store)
            .tree(story.id)
            ?.sections.find((section) => section.key === 'findings');

        expect(findings?.title).toBe('Findings');
        expect(findings?.entries).toEqual([
            {
                key: 'finding:finding_0',
                title: 'major · let the keeper lie first',
                // `Kind` sits right under `State` and only here: it is the claim type, not a status.
                body:
                    'State: approved\n' +
                    'Kind: proposal\n' +
                    'Target: summary_0\n' +
                    'Criterion: C-14\n' +
                    'Detail: opening on the lie gives chapter 2 its tension\n' +
                    'Evidence: section_1: "he told them the truth"\n' +
                    'Seen: 2',
                tags: ['story:story_0', 'section:findings', 'entry:finding:finding_0']
            },
            {
                key: 'finding:finding_1',
                title: 'major · the ending does not pay the promise',
                body:
                    'State: confirmed\n' +
                    'Target: summary_0\n' +
                    'Criterion: C-14\n' +
                    'Detail: nothing in the ending answers the promise\n' +
                    'Evidence: ending: she floods it\n' +
                    'Seen: 1',
                tags: ['story:story_0', 'section:findings', 'entry:finding:finding_1']
            },
            {
                // The legacy row: no `kind` stored, and the card reads exactly as it did before T5.
                key: 'finding:finding_2',
                title: 'minor · the 1911 map is never paid off',
                body:
                    'State: unconfirmed\n' +
                    'Target: chapter_0\n' +
                    'Criterion: C-9\n' +
                    'Detail: chapter_1 sec_1 mentions the map; nothing answers it\n' +
                    'Evidence: chapter_1 sec_1\n' +
                    'Seen: 1',
                tags: ['story:story_0', 'section:findings', 'entry:finding:finding_2']
            }
        ]);
        // Marker-only rendering, asserted directly so a future "print the default too" change fails
        // here rather than in a client that started depending on the extra line.
        const bodies = (findings?.entries ?? []).map((entry) => entry.body);

        expect(bodies[0]).toContain('Kind: proposal');
        expect(bodies[1]).not.toContain('Kind');
        expect(bodies[2]).not.toContain('Kind');
    });
});
