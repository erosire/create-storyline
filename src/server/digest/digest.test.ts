// W6 acceptance — each name cites the clause it pins (§4.8, D-12/D-12a/D-13/D-14, T-7).
//
//   the body carries recap + chapter lines + open threads + cast state + change notes (§4.8)
//   rebuild advances the rev and archives the previous row (§4.8 "one current record + history")
//   isStale turns true after a commit past the Digest's anchor (D-14)
//   an open `digest_gap` switches the derivation to expanded detail (D-13)
//   the derivation is attributed to the engine and no one else (D-12a: no agent writes the Digest)
//   the body stays bounded (T-7) and the same state derives the same text (D-12a reconstructibility)
import { beforeEach, describe, expect, it } from 'vitest';

import { Store, type Attribution } from '../store';
import type {
    Chapter,
    Cost,
    Finding,
    FindingState,
    LedgerKind,
    LedgerStatus,
    Story,
    StoryPhase
} from '../../shared/types';
import { DIGEST_CHAR_BUDGET, DIGEST_GAP_CRITERION, DigestBuilder } from './digest';

const AUTHOR: Attribution = { run_ref: null, author: true, why: 'author seeds the story' };
const WRITER: Attribution = { run_ref: 'run_1', why: 'writer produces the artifact' };
const CHECKER: Attribution = { run_ref: 'run_2', why: 'checker reports the finding' };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createStory(store: Store, phase: StoryPhase = 'chapters'): Story {
    return store.stories.create(
        {
            title: 'The Reservoir',
            phase,
            idea: 'A cartographer returns to the valley she mapped as a girl and finds it redrawn by a reservoir.',
            summary_locked: true,
            plotlines_locked: true,
            pending_kind: 'none',
            status: 'ready',
            trend: 'unknown',
            auto_approve: ['critical', 'major'],
            author_stop: false,
            digest_rev: 0,
            template_refs: [],
            chapter_deps: {}
        },
        AUTHOR
    );
}

function createSummary(store: Store, storyId: string): void {
    store.summaries.create(
        {
            story_id: storyId,
            chapter_count: 2,
            premise: 'A mapmaker returns to a drowned valley.',
            promise: 'The valley gives back what it took.',
            theme: 'Memory outlives the map.',
            tone: 'Close third, past tense, spare.',
            ending: 'She lets the water keep the map.',
            world_rules: 'The reservoir never fully drains.',
            locked: true
        },
        WRITER
    );
}

function createPlotline(store: Store, storyId: string, order: number): void {
    store.plotlines.create(
        {
            story_id: storyId,
            order,
            heading: `Beat ${order}`,
            must_happen: 'the map is burned',
            must_change: 'she no longer owns the valley',
            contract_locked: true,
            aligned: true,
            needs_recheck: false
        },
        WRITER
    );
}

function createChapter(store: Store, storyId: string, order: number, title: string, summary?: string): Chapter {
    return store.chapters.create(
        {
            story_id: storyId,
            plotline_ref: `plotline_${order}`,
            order,
            title,
            summary,
            sections: [
                {
                    id: `section_${order}`,
                    text: 'The water is still moving.',
                    origin: 'writer',
                    last_run_ref: 'run_1',
                    last_why: 'drafted the approach'
                }
            ],
            state: 'drafting',
            author_locked: false,
            round: 1
        },
        WRITER
    );
}

function createLedger(
    store: Store,
    storyId: string,
    kind: LedgerKind,
    subject: string,
    status: LedgerStatus,
    chapterRef?: string
): string {
    return store.ledger.create({ story_id: storyId, kind, subject, chapter_ref: chapterRef, status }, WRITER).id;
}

function createCast(store: Store, storyId: string, name: string, stateNow?: string, arc?: string): void {
    store.cast.create({ story_id: storyId, name, state_now: stateNow, arc }, WRITER);
}

function createFinding(
    store: Store,
    storyId: string,
    criterionRef: string,
    cost: Cost,
    state: FindingState,
    targetRef = 'chapter_1'
): Finding {
    return store.findings.create(
        {
            story_id: storyId,
            target_ref: targetRef,
            criterion_ref: criterionRef,
            title: `${criterionRef} is not met`,
            evidence: 'the chapter never burns the map',
            cost,
            fingerprint: `fp_${criterionRef}_${state}`,
            state,
            seen_count: 1
        },
        CHECKER
    );
}

/** A Story with the artifacts a Phase 3 reviewer stands on: summary, two plotlines, two chapters. */
function seedStory(store: Store): Story {
    const story = createStory(store);

    createSummary(store, story.id);
    createPlotline(store, story.id, 1);
    createPlotline(store, story.id, 2);
    createChapter(
        store,
        story.id,
        1,
        'The Low Road',
        'Vera reaches the valley road and finds the water higher than the map.'
    );
    createChapter(store, story.id, 2, 'The Keeper');

    return story;
}

describe('DigestBuilder — the derived standing view (§4.8, D-12a)', () => {
    let store: Store;
    let builder: DigestBuilder;
    let story: Story;

    beforeEach(() => {
        store = Store.empty();
        builder = new DigestBuilder();
        story = seedStory(store);

        createLedger(store, story.id, 'setup', 'the mentor knows', 'open', 'chapter_1');
        createLedger(store, story.id, 'setup', 'The Pistol', 'open', 'chapter_2');
        createLedger(store, story.id, 'payoff', 'The Pistol', 'paid', 'chapter_2');
        createLedger(store, story.id, 'fact', 'the flood date', 'conflict');

        createCast(store, story.id, 'Vera', 'on the valley road, map in hand', 'from mapmaker to witness');
        createCast(store, story.id, 'Cole');

        createFinding(store, story.id, 'C-4', 'critical', 'confirmed');
        createFinding(store, story.id, 'C-12', 'minor', 'unconfirmed');
        createFinding(store, story.id, 'C-11', 'taste', 'fixed');
    });

    it('carries the bible recap, the chapter lines, the open threads, the cast state and the change notes', () => {
        const body = builder.buildBody(store, story.id, 7);

        expect(body.split('\n')).toEqual([
            'digest · story_1 · rev 7',
            '',
            '## bible',
            'declared chapters: 2 · Summary locked (P5: read-only, backtrack only)',
            'premise: A mapmaker returns to a drowned valley.',
            'promise: The valley gives back what it took.',
            'theme: Memory outlives the map.',
            'tone: Close third, past tense, spare.',
            'ending: She lets the water keep the map.',
            'world_rules: The reservoir never fully drains.',
            '',
            '## chapters',
            '1 · The Low Road — Vera reaches the valley road and finds the water higher than the map. [1 section(s), drafting]',
            '2 · The Keeper — The water is still moving. [1 section(s), drafting]',
            '',
            '## open threads',
            'open findings: 1 critical, 1 minor',
            'ledger conflicts: ledger_entry_4 "the flood date"',
            'open setup · the mentor knows: ledger_entry_1@chapter_1',
            'open setup · The Pistol: ledger_entry_2@chapter_2',
            '',
            '## cast',
            'Cole — now: (not recorded)',
            'Vera — now: on the valley road, map in hand | arc: from mapmaker to witness',
            '',
            '## last changes',
            // 15 writes have happened, and §4.8 asks for LAST change notes: the newest 12, oldest
            // first, so seq 1–3 have already aged out of the brief (they are still in the journal).
            '4 · create plotline_2 — writer produces the artifact (by run run_1)',
            '5 · create chapter_1 — writer produces the artifact (by run run_1)',
            '6 · create chapter_2 — writer produces the artifact (by run run_1)',
            '7 · create ledger_entry_1 — writer produces the artifact (by run run_1)',
            '8 · create ledger_entry_2 — writer produces the artifact (by run run_1)',
            '9 · create ledger_entry_3 — writer produces the artifact (by run run_1)',
            '10 · create ledger_entry_4 — writer produces the artifact (by run run_1)',
            '11 · create cast_member_1 — writer produces the artifact (by run run_1)',
            '12 · create cast_member_2 — writer produces the artifact (by run run_1)',
            '13 · create finding_1 — checker reports the finding (by run run_2)',
            '14 · create finding_2 — checker reports the finding (by run run_2)',
            '15 · create finding_3 — checker reports the finding (by run run_2)'
        ]);
    });

    it('names who moved the story last, in whose run, and for what stated why (D-8, P11)', () => {
        store.chapters.update(
            story.id === 'story_1' ? 'chapter_2' : 'chapter_2',
            { title: 'The Keeper of the Low Road' },
            { run_ref: 'run_7', why: 'editor retitles to separate the two keepers' },
            [{ id: 'chapter_2', rev: 1 }]
        );
        store.chapters.update(
            'chapter_1',
            { author_locked: true },
            { run_ref: null, author: true, assistant: true, why: 'author locks the chapter while paused' },
            [{ id: 'chapter_1', rev: 1 }]
        );

        const notes = builder.buildBody(store, story.id, 1).split('\n').slice(-2);

        expect(notes).toEqual([
            '16 · update chapter_2 — editor retitles to separate the two keepers (by run run_7)',
            '17 · update chapter_1 — author locks the chapter while paused (by assistant)'
        ]);
    });

    it('shows a bare Story the same five sections, with every list empty rather than absent', () => {
        const bare = Store.empty();
        const storyOnly = createStory(bare);

        new DigestBuilder().rebuild(bare, storyOnly.id);

        expect(bare.digests.list()[0].body).toBe(
            [
                'digest · story_1 · rev 1',
                '',
                '## bible',
                'no Summary record yet — this Story is still pre-Phase-1',
                '',
                '## chapters',
                'no chapters written yet',
                '',
                '## open threads',
                'open findings: none',
                'ledger conflicts: none',
                'open setups: none',
                '',
                '## cast',
                'no cast recorded',
                '',
                '## last changes',
                '1 · create story_1 — author seeds the story (by author)'
                // One blank line between sections — the same shape the first test pins by splitting
                // the body on '\n'. A bare Story has nothing to thin, so nothing is elided.
            ].join('\n')
        );
    });

    it('derives the same text for the same committed state, so any past Digest is reconstructible (D-12a)', () => {
        const first = builder.buildBody(store, story.id, 12);
        const again = builder.buildBody(store, story.id, 12);

        expect(again).toBe(first);

        const rev1 = builder.rebuild(store, story.id);
        const rev2 = builder.rebuild(store, story.id);

        // Nothing but the header moves between two rebuilds of one state: the notes exclude the
        // Digest's own writes, which is the difference between "reconstructible" and "self-exciting".
        expect(rev2.body).toBe(rev1.body.replace('· rev 1', '· rev 2'));
    });

    // -- the current row, its history, and rev (D-12a) -----------------------------------------

    it('advances the Story digest rev, keeps exactly one current row, and archives the last one', () => {
        const first = builder.rebuild(store, story.id);

        expect(store.stories.require(story.id).digest_rev).toBe(1);
        expect(first.id).toBe('digest_1');
        expect(first.current).toBe(true);
        expect(first.stale).toBe(false);
        expect(first.body.startsWith('digest · story_1 · rev 1\n')).toBe(true);

        builder.rebuild(store, story.id);

        expect(store.stories.require(story.id).digest_rev).toBe(2);
        expect(
            store.digests.list().map((row) => ({ id: row.id, current: row.current, stale: row.stale, rev: row.rev }))
        ).toEqual([
            { id: 'digest_1', current: false, stale: false, rev: 2 },
            { id: 'digest_2', current: true, stale: false, rev: 1 }
        ]);
        expect(store.digests.list()[1].body.startsWith('digest · story_1 · rev 2\n')).toBe(true);
        expect(builder.currentDigest(store, story.id)?.id).toBe('digest_2');
    });

    it('is attributed to the engine with no run and no author — no agent writes the Digest (D-12a)', () => {
        builder.rebuild(store, story.id);
        builder.rebuild(store, story.id);

        const digestEvents = store.journal.filter((event) => event.collection === 'digests');

        expect(digestEvents.map((event) => `${event.op}:${event.id}`)).toEqual([
            'create:digest_1',
            'update:digest_1',
            'create:digest_2'
        ]);
        expect(
            digestEvents.every(
                (event) =>
                    event.attribution.run_ref === null &&
                    event.attribution.author === undefined &&
                    event.attribution.assistant === undefined
            )
        ).toBe(true);

        const created = digestEvents.find((event) => event.op === 'create' && event.id === 'digest_2')!;

        expect(created.attribution.why).toBe(
            `engine-derived: derived digest rev 2 from journal through seq ${store.digests.require('digest_2').journal_seq} (D-12a)`
        );
    });

    it('anchors the row on the journal position it read, which is what makes a past Digest locatable (D-12a, W6)', () => {
        const expectedAnchor = store.journal
            .filter((event) => event.collection !== 'digests')
            .reduce((highest, event) => Math.max(highest, event.seq), 0);

        expect(expectedAnchor).toBe(15);

        builder.rebuild(store, story.id);

        expect(builder.currentDigest(store, story.id)?.journal_seq).toBe(15);
    });

    // -- staleness (D-14) ----------------------------------------------------------------------

    it('is fresh the moment it is derived and stale as soon as story state moves (D-14)', () => {
        builder.rebuild(store, story.id);

        expect(builder.isStale(store, store.stories.require(story.id))).toBe(false);

        store.chapters.create(
            {
                story_id: story.id,
                plotline_ref: 'plotline_1',
                order: 3,
                title: 'Chapter 3',
                sections: [],
                state: 'outlined',
                author_locked: false,
                round: 0
            },
            WRITER
        );

        expect(builder.isStale(store, store.stories.require(story.id))).toBe(true);
    });

    it('calls a Story with no Digest stale — D-14 refreshes rather than skips', () => {
        expect(builder.isStale(store, story)).toBe(true);
        expect(builder.currentDigest(store, story.id)).toBeUndefined();
    });

    it('treats a deleted record as story state, since a scrap changes the book (D-22, D-25a)', () => {
        builder.rebuild(store, story.id);

        expect(builder.isStale(store, store.stories.require(story.id))).toBe(false);

        store.chapters.delete(
            'chapter_2',
            { run_ref: null, author: true, why: 'author backtracks to phase 2 and scraps the prose' },
            [{ id: 'chapter_2', rev: 1 }]
        );

        expect(builder.isStale(store, store.stories.require(story.id))).toBe(true);
    });

    it('stays fresh when only ANOTHER Story moved (T-3)', () => {
        builder.rebuild(store, story.id);

        const other = createStory(store, 'summary');

        createSummary(store, other.id);
        createChapter(store, other.id, 1, 'Another book');

        expect(builder.isStale(store, store.stories.require(story.id))).toBe(false);
        expect(builder.isStale(store, store.stories.require(other.id))).toBe(true);
    });

    it('does not call itself stale for the digest_rev bump it wrote (D-12a, D-14)', () => {
        const before = builder.rebuild(store, story.id);
        const storyEvents = store.journal.filter((event) => event.collection === 'stories');

        // The bump is in the journal (P11 requires every write) but it is the Digest's own
        // bookkeeping, so it must not re-arm staleness — otherwise D-14 would block every review.
        expect(storyEvents.map((event) => event.id)).toEqual(['story_1', 'story_1']);
        expect(before.stale).toBe(false);
        expect(builder.isStale(store, store.stories.require(story.id))).toBe(false);
    });

    // -- D-13: the crew's only move against the Digest -----------------------------------------

    it('switches to expanded detail while a digest_gap finding is open, and back when it closes', () => {
        const compact = builder.buildBody(store, story.id, 1);

        expect(compact).not.toContain('must_happen');
        expect(builder.isExpanded(store, story.id)).toBe(false);

        const gap = createFinding(store, story.id, DIGEST_GAP_CRITERION, 'major', 'unconfirmed');

        expect(builder.isExpanded(store, story.id)).toBe(true);

        const expanded = builder.buildBody(store, story.id, 2);

        // 20 lines: head + bible + both chapters with their two contract lines each, up to and
        // including the next section header. The contract lines are the whole D-13 repair.
        expect(expanded.split('\n').slice(0, 20)).toEqual([
            'digest · story_1 · rev 2 · expanded detail (open digest_gap, D-13)',
            '',
            '## bible',
            'declared chapters: 2 · Summary locked (P5: read-only, backtrack only)',
            'premise: A mapmaker returns to a drowned valley.',
            'promise: The valley gives back what it took.',
            'theme: Memory outlives the map.',
            'tone: Close third, past tense, spare.',
            'ending: She lets the water keep the map.',
            'world_rules: The reservoir never fully drains.',
            '',
            '## chapters',
            '1 · The Low Road — Vera reaches the valley road and finds the water higher than the map. [1 section(s), drafting]',
            '  must_happen: the map is burned',
            '  must_change: she no longer owns the valley',
            '2 · The Keeper — The water is still moving. [1 section(s), drafting]',
            '  must_happen: the map is burned',
            '  must_change: she no longer owns the valley',
            '',
            '## open threads'
        ]);
        expect(expanded).toContain('open findings: 1 critical, 1 major, 1 minor');

        // Closing the gap is the loop's move, and the detail collapses back on the next derivation.
        store.findings.update(
            gap.id,
            { state: 'fixed' },
            { run_ref: 'run_3', why: 'loop closes the gap after the rebuild' },
            [{ id: gap.id, rev: 1 }]
        );

        expect(builder.isExpanded(store, story.id)).toBe(false);
        expect(builder.buildBody(store, story.id, 3)).not.toContain('must_happen');
    });

    it('names a chapter whose contract is missing instead of inventing one (C-1)', () => {
        store.chapters.update('chapter_2', { plotline_ref: '' }, WRITER, [{ id: 'chapter_2', rev: 1 }]);
        createFinding(store, story.id, DIGEST_GAP_CRITERION, 'minor', 'confirmed');

        expect(builder.buildBody(store, story.id, 1).split('\n')).toContain(
            '  contract: none bound — this chapter has no plotline to judge it against (C-1)'
        );
    });

    // -- the budget (T-7) ----------------------------------------------------------------------

    it('clamps a long synopsis to one bounded line, because §4.8 asks for a one-liner', () => {
        const long =
            'Vera walks the drowned road, and every marker she mapped in 1911 is under water, and she keeps naming them anyway, until the naming stops being a map and becomes a litany she cannot stop saying out loud in the dark.';
        const clamped = `${long.slice(0, 159)}…`;

        expect(clamped.length).toBe(160);

        store.chapters.update('chapter_2', { summary: long }, WRITER, [{ id: 'chapter_2', rev: 1 }]);

        expect(builder.buildBody(store, story.id, 1).split('\n')).toContain(
            `2 · The Keeper — ${clamped} [1 section(s), drafting]`
        );
    });

    it('collapses a multi-paragraph field into one line rather than breaking the section', () => {
        store.summaries.update('summary_1', { premise: 'A mapmaker\n\nreturns\nto   a drowned valley.' }, WRITER, [
            { id: 'summary_1', rev: 1 }
        ]);

        expect(builder.buildBody(store, story.id, 1)).toContain('premise: A mapmaker returns to a drowned valley.');
    });

    it('keeps the load-bearing sections when the book is long, dropping the oldest change notes first (T-7)', () => {
        for (let order = 3; order <= 40; order += 1) {
            store.chapters.create(
                {
                    story_id: story.id,
                    plotline_ref: `plotline_${order}`,
                    order,
                    title: `Chapter ${order}`,
                    sections: [{ id: `section_${order}`, text: 'x'.repeat(400), origin: 'writer' }],
                    state: 'drafting',
                    author_locked: false,
                    round: 2
                },
                WRITER
            );
        }

        const body = builder.buildBody(store, story.id, 4);

        expect(body.length).toBeLessThanOrEqual(DIGEST_CHAR_BUDGET);
        expect(body).toContain('## bible');
        expect(body).toContain('## open threads');
        expect(body).toContain('## cast');
        expect(body).toContain('39 · Chapter 39');
        expect(body).not.toContain('1 · create story_1');
        expect(body.endsWith('…')).toBe(false);
    });

    it('thins the widest block instead of truncating, so no section is ever lost (T-7, D-13)', () => {
        // 32 cast members, two of them carrying 300-char fields, is a store whose bulk is entirely
        // in one block. The ladder must shed THAT block: the recap, the spine and the open threads
        // stay whole (W6: a reviewer judges a chapter from this text), and the change notes fall to
        // their floor because the journal still holds them. Padding runs are collapsed below so every
        // surviving line is assertable as a short exact string.
        for (let order = 1; order <= 30; order += 1) {
            store.cast.create(
                {
                    story_id: story.id,
                    name: `Extra character ${order}`,
                    state_now: 'y'.repeat(300),
                    arc: 'z'.repeat(300)
                },
                WRITER
            );
        }

        const body = builder.buildBody(store, story.id, 1);

        expect(
            body
                .replace(/y{40,}/g, 'Y')
                .replace(/z{40,}/g, 'Z')
                .split('\n')
        ).toEqual([
            'digest · story_1 · rev 1',
            '',
            '## bible',
            'declared chapters: 2 · Summary locked (P5: read-only, backtrack only)',
            'premise: A mapmaker returns to a drowned valley.',
            'promise: The valley gives back what it took.',
            'theme: Memory outlives the map.',
            'tone: Close third, past tense, spare.',
            'ending: She lets the water keep the map.',
            'world_rules: The reservoir never fully drains.',
            '',
            '## chapters',
            '1 · The Low Road — Vera reaches the valley road and finds the water higher than the map. [1 section(s), drafting]',
            '2 · The Keeper — The water is still moving. [1 section(s), drafting]',
            '',
            '## open threads',
            'open findings: 1 critical, 1 minor',
            'ledger conflicts: ledger_entry_4 "the flood date"',
            'open setup · the mentor knows: ledger_entry_1@chapter_1',
            'open setup · The Pistol: ledger_entry_2@chapter_2',
            '',
            '## cast',
            'Cole — now: (not recorded)',
            // Alphabetical, so the thinning takes the tail of the block and says how much went.
            'Extra character 1 — now: Y | arc: Z',
            'Extra character 10 — now: Y | arc: Z',
            'Extra character 11 — now: Y | arc: Z',
            'Extra character 12 — now: Y | arc: Z',
            'Extra character 13 — now: Y | arc: Z',
            'Extra character 14 — now: Y | arc: Z',
            'Extra character 15 — now: Y | arc: Z',
            '… 24 cast line(s) elided to hold the Digest budget (T-7)',
            '',
            '## last changes',
            '45 · create cast_member_32 — writer produces the artifact (by run run_1)',
            '… 11 change note(s) elided to hold the Digest budget (T-7)'
        ]);

        // The ceiling is what the ladder is for, and the ladder gets there without a hard cut: every
        // line is clamped at the field level, so overflow is always a line COUNT problem, which
        // thinning solves. A truncated body would silently drop the last section.
        expect(body.length).toBeLessThanOrEqual(DIGEST_CHAR_BUDGET);
        expect(body.endsWith('…')).toBe(false);
    });

    it('says what it left out, so a run can tell a thin Digest from a thin book (D-13)', () => {
        // The elision line is D-13's hook: without it, a crew reading eight cast members cannot tell
        // whether the book has eight characters or thirty-two, and cannot file an informed digest_gap.
        for (let order = 1; order <= 30; order += 1) {
            store.cast.create(
                {
                    story_id: story.id,
                    name: `Extra character ${order}`,
                    state_now: 'y'.repeat(300),
                    arc: 'z'.repeat(300)
                },
                WRITER
            );
        }

        const lines = builder.buildBody(store, story.id, 1).split('\n');

        expect(lines.filter((line) => line.includes('elided to hold the Digest budget'))).toEqual([
            '… 24 cast line(s) elided to hold the Digest budget (T-7)',
            '… 11 change note(s) elided to hold the Digest budget (T-7)'
        ]);
        // Every section header survives, which is what "no section is ever lost" means in practice.
        expect(lines.filter((line) => line.startsWith('## '))).toEqual([
            '## bible',
            '## chapters',
            '## open threads',
            '## cast',
            '## last changes'
        ]);
    });

    // -- W6's acceptance shape -----------------------------------------------------------------

    it('lets a reviewer judge chapter 20 without reading chapters 1–19 (W6)', () => {
        const many = Store.empty();
        const book = createStory(many);

        createSummary(many, book.id);

        // Long enough that the Digest must summarise the chapter rather than quote it: §4.8 asks for
        // one bounded line per chapter, and an unclamped line here would blow the budget on its own.
        const prose =
            'the water keeps rising through the prose of this chapter, at length, on and on, past every marker she mapped'.repeat(
                4
            );

        for (let order = 1; order <= 20; order += 1) {
            createPlotline(many, book.id, order);
            many.chapters.create(
                {
                    story_id: book.id,
                    plotline_ref: `plotline_${order}`,
                    order,
                    title: order === 20 ? 'The Low Road Ends' : `Chapter ${order}`,
                    sections: [
                        {
                            id: `section_${order}`,
                            text: prose,
                            origin: 'writer'
                        }
                    ],
                    state: 'drafting',
                    author_locked: false,
                    round: 3
                },
                WRITER
            );
        }

        const body = new DigestBuilder().buildBody(many, book.id, 1);

        // The last chapter's line is the one a Phase 3 reviewer needs, and it carries the chapter's
        // own clamped gist plus its state — enough to judge C-7/C-8/C-12 without opening 1–19.
        expect(body).toContain(`20 · The Low Road Ends — ${prose.slice(0, 159)}… [1 section(s), drafting]`);
        expect(body).toContain('premise: A mapmaker returns to a drowned valley.');
        expect(body).toContain('open setups: none');
        expect(body.length).toBeLessThanOrEqual(DIGEST_CHAR_BUDGET);
    });
});
