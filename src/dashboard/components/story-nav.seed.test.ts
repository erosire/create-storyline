// U-25 — the navigation model behind "the Seed belongs to the Phrase 1 … Phrase 2 have different seed".
//
// The Seed stopped being a panel (`'seed'`, pinned above the phrases) and became a CHILD of each phrase, addressed by
// a synthetic ref on the phrase's own panel. Four rules have to hold together for that row to work, and none of them
// is visible from the rail alone, so they are pinned here against the pure nav model:
//
//   1. THE REF IS A TOKEN, not an id: `phraseSeedRef()` is one fixed string, `isPhraseSeedRef` reads it back, and it
//      cannot be confused with `summary-group:<uuid>`, `revision:<id>`, `plotlines-group:<uuid>` or a bare uuid.
//   2. `selectionExists` ACCEPTS it. This is the load-bearing one: `StoryView` replaces a selection this predicate
//      rejects with `{panel}` and silently lands on the Overview, so a rejected Seed ref would fail as a no-op.
//   3. The TITLES resolve it through `phraseLabel`, so the content area says WHICH phrase's Seed is open.
//   4. `attentionFor` answers nothing (a Seed is pinned truth, not work) and `directiveFocus` keeps the Seed sentence
//      for Phrase ① while addressing the phrase's OWN Seed for Phrase ② — it must not fall through to the group or
//      plotline-set focus of its panel.
import { describe, expect, it } from 'vitest';

import {
    ALL_STORY_PHRASES,
    DEFAULT_STORY_SELECTION,
    PHRASE_SEED_REF,
    attentionFor,
    directiveFocus,
    isPhraseSeedRef,
    parsePlotlineGroupRef,
    parseSummaryGroupRef,
    parseSummaryRevisionRef,
    phraseLabel,
    phraseSeedRef,
    plotlineGroupFocus,
    selectionExists,
    selectionTitle,
    summaryGroupFocus,
    summaryRevisionFocus
} from './story-nav';
import { fixturePhrase, fixtureView } from '../testing/story-fixtures';
import { phraseDetailView } from '../testing/shell-fakes';
import type { StoryViewData } from './story-contract';

/** A group-managed Phrase ①: five group rows on the wire, so the rail's Summary children are real. */
function groupedSummary(): StoryViewData {
    return fixtureView({ phrase: fixturePhrase() });
}

/** The same book with Phrase ② started and read: the frame in which Phrase ②'s Seed row has a copied text. */
function phraseTwoStarted(): StoryViewData {
    const view = groupedSummary();

    return {
        ...view,
        plotlines_mode: 'groups',
        story: { ...view.story, plotlines_mode: 'groups' },
        phrase_started: { summary: true, plotlines: true },
        summary_compiled: true,
        phraseDetail: phraseDetailView('s1')
    };
}

describe('story-nav — the Seed is a synthetic child ref, not a panel (U-25)', () => {
    it('names one fixed token, and reads it back from itself only', () => {
        expect(PHRASE_SEED_REF).toBe('phrase-seed');
        expect(phraseSeedRef()).toBe(PHRASE_SEED_REF);
        expect(isPhraseSeedRef(phraseSeedRef())).toBe(true);
        // An absent ref is the phrase's own Overview — the distinction the row exists to make.
        expect(isPhraseSeedRef(undefined)).toBe(false);
        // Every OTHER ref shape on these panels reads as false, and the token cannot collide with one: a group ref
        // carries a uuid, a revision ref carries the `revision:` prefix, and a record id is a bare uuid.
        expect(isPhraseSeedRef('summary-group:grp-promise')).toBe(false);
        expect(isPhraseSeedRef('revision:rv-1')).toBe(false);
        expect(isPhraseSeedRef('plotlines-group:entry-chapter_1')).toBe(false);
        expect(isPhraseSeedRef('c2')).toBe(false);
        // And a near-miss is not a match: the guard is exact, so a prefixed token cannot be read as the Seed.
        expect(isPhraseSeedRef(`${PHRASE_SEED_REF}-2`)).toBe(false);
        expect(isPhraseSeedRef('')).toBe(false);
    });

    it('leaves the retired `seed` panel out of the phrase vocabulary it numbers', () => {
        // `selectionTitle` resolves a phrase from `ALL_STORY_PHRASES`; `'seed'` is gone from `StoryPanelKey`, so the
        // only panels left are phrases, folders and the supplementary sheet.
        expect(ALL_STORY_PHRASES.map((phrase) => phrase.key)).toEqual(['summary', 'plotlines', 'chapters']);
        expect(
            ALL_STORY_PHRASES.map((phrase) => phrase.title).includes('Seed')
        ).toBe(false);
    });
});

describe('story-nav — the Seed ref survives routing on every phrase (U-25)', () => {
    it('is accepted where a record ref would be dropped as stale', () => {
        const view = phraseTwoStarted();

        // Phrase ①: the Seed is `story.idea`, and a group that no longer exists would fall back while the Seed does
        // not. The pair of assertions IS the routing promise.
        expect(selectionExists(view, { panel: 'summary', ref: phraseSeedRef() })).toBe(true);
        expect(selectionExists(view, { panel: 'summary', ref: 'summary-group:grp-gone' })).toBe(false);
        // Phrase ②: same answer with the read landed, and with the phrase never started (`phrase_started:false` is a
        // real state the pane explains, not a missing record).
        expect(selectionExists(view, { panel: 'plotlines', ref: phraseSeedRef() })).toBe(true);
        expect(selectionExists(view, { panel: 'plotlines', ref: 'plotlines-group:gone' })).toBe(false);

        const unstarted = { ...view, phrase_started: { summary: true, plotlines: false } };

        expect(selectionExists(unstarted, { panel: 'plotlines', ref: phraseSeedRef() })).toBe(true);
        // A phrase with no read at all (the classic dial), and the read FAILED: still no fallback.
        const noRead = { ...view, phraseDetail: undefined };

        expect(selectionExists(noRead, { panel: 'plotlines', ref: phraseSeedRef() })).toBe(true);
        expect(
            selectionExists({ ...view, phraseDetail: null, phraseDetailError: 'the phrase read answered 503' }, {
                panel: 'plotlines',
                ref: phraseSeedRef()
            })
        ).toBe(true);
        // The default selection is untouched: no ref, the phrase's own Overview.
        expect(DEFAULT_STORY_SELECTION).toEqual({ panel: 'summary' });
    });

    it('resolves as no group, no entry and no revision, so no other pane claims the row', () => {
        const view = phraseTwoStarted();
        const selection = { panel: 'summary' as const, ref: phraseSeedRef() };

        expect(summaryGroupFocus(view, selection)).toBeUndefined();
        expect(summaryRevisionFocus(view, selection)).toBeUndefined();
        expect(plotlineGroupFocus(view, { panel: 'plotlines', ref: phraseSeedRef() })).toBeUndefined();
        // The prefix parsers each answer `undefined` for the token — the ref is a sibling of those shapes, never one.
        expect(parseSummaryGroupRef(phraseSeedRef())).toBeUndefined();
        expect(parseSummaryRevisionRef(phraseSeedRef())).toBeUndefined();
        expect(parsePlotlineGroupRef(phraseSeedRef())).toBeUndefined();
    });
});

describe('story-nav — the content area says WHICH phrase’s Seed is open (U-25)', () => {
    it('titles each phrase’s Seed with the phrase label, and nothing else', () => {
        const view = phraseTwoStarted();

        expect(phraseLabel(ALL_STORY_PHRASES[0]!)).toBe('Phrase 1 — Summary');
        expect(phraseLabel(ALL_STORY_PHRASES[1]!)).toBe('Phrase 2 — Plotlines');
        expect(selectionTitle(view, { panel: 'summary', ref: phraseSeedRef() })).toBe('Phrase 1 — Summary · Seed');
        expect(selectionTitle(view, { panel: 'plotlines', ref: phraseSeedRef() })).toBe('Phrase 2 — Plotlines · Seed');
        // Phrase ③ inherits the row from the phrase list, and the title with it — nothing about the naming is
        // hard-coded to the two phrases the rail renders today.
        expect(selectionTitle(view, { panel: 'chapters', ref: phraseSeedRef() })).toBe('Phrase 3 — Chapters · Seed');
        // The phrase header itself still titles as the Overview, so the two rows are distinguishable.
        expect(selectionTitle(view, { panel: 'summary' })).toBe('Phrase 1 — Summary');
        expect(selectionTitle(view, { panel: 'plotlines' })).toBe('Phrase 2 — Plotlines');
    });

    it('marks nothing, because a Seed is pinned truth rather than work (P5)', () => {
        const view = groupedSummary();

        // The book DOES carry attention on its Summary group rows — the fixture's findings put it there — and the
        // Seed row still gets none of it: `storyAttention` never names the seed ref, so the rail draws no dot, no
        // tone class and no tooltip on it, and it does not inherit the phrase header's mark either.
        expect(attentionFor(view, 'summary', 'summary-group:grp-premise') ?? null).not.toBeNull();
        expect(attentionFor(view, 'summary', phraseSeedRef())).toBeUndefined();
        expect(attentionFor(view, 'plotlines', phraseSeedRef())).toBeUndefined();
        // A seed ref on a folder panel is still nothing to mark.
        expect(attentionFor(view, 'ideas', phraseSeedRef())).toBeUndefined();
    });
});

describe('story-nav — the directive bar addresses the Seed the Author is standing on (U-25)', () => {
    it('keeps the Seed sentence for Phrase ①, whose Seed is the Author’s idea', () => {
        const view = phraseTwoStarted();

        // Byte-for-byte the focus this function printed while the Seed was still its own panel: same label, same
        // sentence, same placeholder, and no artifact refs (the loop reads the Seed as input, not as a row).
        expect(directiveFocus(view, { panel: 'summary', ref: phraseSeedRef() })).toEqual({
            label: 'Seed → Editor',
            target: 'the Seed (read-only for every agent — P5)',
            placeholder: 'what should the Editor do with this Seed?',
            refs: []
        });
    });

    it('addresses Phrase ②’s own Seed, and does not fall through to the plotline set', () => {
        const view = phraseTwoStarted();

        expect(directiveFocus(view, { panel: 'plotlines', ref: phraseSeedRef() })).toEqual({
            label: 'Plotlines → Seed → Editor',
            target: 'the Plotlines phrase’s own Seed (read-only for every agent — P5)',
            placeholder: 'what should the Editor do with this phrase’s Seed?',
            // The phrase row is the address the bar hands the server — the same id the Summary branch uses when no
            // group is open, and it comes from Phrase ②'s read (`phraseDetail`), not from Phrase ①'s.
            refs: ['phrase_plotlines_1']
        });

        // With no phrase read in the frame, the sentence stands and the refs go empty — the bar addresses nothing it
        // has not been told about.
        expect(directiveFocus(groupedSummary(), { panel: 'plotlines', ref: phraseSeedRef() }).refs).toEqual([]);
        // A chapter entry on the same panel still addresses ITSELF, so the seed branch did not displace the entry
        // branch it sits above.
        expect(
            directiveFocus(view, { panel: 'plotlines', ref: 'plotlines-group:entry-chapter_1' }).refs
        ).toEqual(['entry-chapter_1']);
        // Phrase ①'s group ref still addresses its group, for the same reason.
        expect(
            directiveFocus(groupedSummary(), { panel: 'summary', ref: 'summary-group:grp-theme' }).refs
        ).toEqual(['grp-theme']);
    });
});
