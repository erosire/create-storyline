// R6 / U5 — the GROUP derivations and the sign-off gate they feed.
//
// The acceptance question this suite answers is the one the report was written about: can the dashboard
// claim the book is ready to sign off while the Summary is still incomplete? For a group-managed Story
// "incomplete" is four facts off the phrase read — a group with no revision, a finding at a blocking cost
// that names a group, work still in the group queue, and a Writer holding a group's text — and each one
// has to reach the gate as a sentence the Author can act on.
//
// These are also the ONLY place the rules are decided: the rail's badges, the Overview's rows, the group
// pane's finding chips and the lock all read these functions, so a rule pinned here is pinned everywhere.
//
// D-67/D-68 add a second set of those rules — WHICH text the Summary tab prints, which number belongs beside
// it, why a group is missing from the reviewed Overview, and when the Author may choose it. The pane tests
// render the sentences; this suite pins the decisions underneath them, because a second surface (the rail, a
// future panel) has to reach the same answers from the same wire.
import { describe, expect, it } from 'vitest';

import {
    findingGroups,
    findingKindLabel,
    findingKindToken,
    findingTargetsGroup,
    groupArchivedRevisions,
    groupBlockingFindings,
    groupLatestRevision,
    groupLatestScore,
    groupOpenFindings,
    groupOpenTasks,
    groupPreviousScore,
    groupPreviousScorePercent,
    groupScorePercent,
    groupScores,
    groupSignOffBlockers,
    isArchivedPhraseFinding,
    isGroupSummary,
    isGroupWritten,
    isGroupWriterBusy,
    lockCheck,
    phraseGroupById,
    phraseGroups,
    phraseOverallScore,
    phraseOverview,
    phraseReviewed,
    phraseScorePercent,
    reviewedBlockingIssues,
    reviewedChooseError,
    reviewedChooseRefusal,
    reviewedGapReason,
    reviewedGaps,
    reviewedGroupRows,
    reviewedState,
    reviewedSummaryText,
    reviewedSupersededGroups,
    summaryBlockingCost,
    unwrittenGroups
} from './story-contract';
import { fixturePhrase, fixtureView } from './story-fixtures';
// R-T2/F1: the rail's ready tick and the Accept button are the SAME fact, and the regression below asserts
// both, so the nav module's derivation is under test here as well as the contract's blocker list.
import { summaryReadyForReview } from './story-nav';
import { groupedPhraseView, reviewedPhraseView } from '../testing/shell-fakes';
import type { StoryViewData } from './story-contract';
import type { PhraseFindingRow, PhraseGroupRow, PhraseGroupScore, PhraseTaskRow, PhraseView } from '../api';
import type { Cost } from '../../shared/types';
import type { Story } from '../../shared/types';

/** The mid-review grouped book: unwritten Ending, open findings, a claimed task, Theme held by the Writer. */
function midReview() {
    return fixtureView({ phrase: fixturePhrase() });
}

/** A grouped view over `groupedPhraseView`'s clean rows, with the rows/findings a case needs. */
function grouped(overrides: Partial<PhraseView> = {}, storyOverrides: Partial<Story> = {}) {
    const view = fixtureView({ phrase: groupedPhraseView('s1', overrides) });

    return { ...view, story: { ...view.story, ...storyOverrides } };
}

/** Phase ①, Goal passing, Ideas tray empty — the frame the gate is asked about. */
function signOffFrame(view: StoryViewData): StoryViewData {
    return {
        ...view,
        story: {
            ...view.story,
            phase: 'summary' as const,
            summary_locked: false,
            status: 'ready' as const,
            pending_kind: 'none' as const,
            status_reason: undefined
        },
        goal: { ...view.goal, failing: [], phase_progress: '4/4' },
        ideas: []
    };
}

/** One group row with only the field a case cares about changed. */
function rowKeyed(phrase: PhraseView, key: string): PhraseGroupRow {
    return phrase.groups.find((row) => row.key === key) as PhraseGroupRow;
}

/** One finding row, scoped the way the projection scopes it. */
function finding(overrides: Partial<PhraseFindingRow> & { id: string }): PhraseFindingRow {
    const targeted = overrides.targeted ?? ['grp-theme'];

    return {
        title: 'the promise names a cost the premise never sets up',
        cost: 'critical',
        state: 'confirmed',
        seen_count: 1,
        group_refs: targeted,
        unscoped: false,
        targeted,
        resolved: [],
        missing: targeted,
        resolved_all: false,
        ...overrides
    };
}

/** One queue row. `state:'done'` is closed; anything else is the crew's open work. */
function task(overrides: Partial<PhraseTaskRow> & { id: string }): PhraseTaskRow {
    return {
        title: 'rewrite Theme to answer the promise it borrows',
        state: 'open',
        owner_role: 'writer',
        attempts: 0,
        finding_ref: null,
        ...overrides
    };
}

describe('story-contract — what makes a Summary group-managed (R6)', () => {
    it('answers from the phrase read first, and from the Story row while the read is in flight', () => {
        expect(isGroupSummary(midReview())).toBe(true);
        expect(isGroupSummary({ ...midReview(), phrase: undefined })).toBe(true);
        // A payload from before the Setting exists is NOT grouped: making it look grouped would put five
        // empty rows on a book that has no group rows to draw.
        const legacy = fixtureView();

        expect(isGroupSummary(legacy)).toBe(false);
        expect(isGroupSummary({ ...legacy, phrase: groupedPhraseView('s1', { mode: 'sampling' }) })).toBe(false);
    });

    it('reads the Overview the server composed, and nothing of its own', () => {
        const view = midReview();

        expect(phraseOverview(view)).toBe(view.phrase?.overview);
        // A grouped book with no Overview yet is the empty string, not a synthesised paragraph.
        expect(phraseOverview(grouped({ overview: '' }))).toBe('');
        expect(phraseOverview(legacyView())).toBe('');
    });
});

describe('story-contract — identity is the id string, order is only for display (U2)', () => {
    it('sorts the rows by composition order and looks a group up by id, never by position', () => {
        const shuffled: PhraseView = {
            ...fixturePhrase(),
            // Delivered out of order, as a refetch with a retitled catalog may do.
            groups: [
                { ...rowKeyed(fixturePhrase(), 'ending') },
                { ...rowKeyed(fixturePhrase(), 'tone') },
                { ...rowKeyed(fixturePhrase(), 'premise') },
                { ...rowKeyed(fixturePhrase(), 'theme') },
                { ...rowKeyed(fixturePhrase(), 'promise') }
            ]
        };
        const view = fixtureView({ phrase: shuffled });

        expect(phraseGroups(view).map((row) => row.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        expect(phraseGroupById(view, 'grp-tone')?.title).toBe('Tone');
        // A reorder moves the DISPLAY without moving the ADDRESS.
        expect(phraseGroups(view)[1].id).toBe('grp-promise');
        expect(phraseGroupById(view, 'nope')).toBeUndefined();
        expect(phraseGroupById(view, undefined)).toBeUndefined();
    });

    it('gives a sampling-mode book no groups at all, whatever the rows contain', () => {
        expect(phraseGroups(fixtureView({ phrase: groupedPhraseView('s1', { mode: 'sampling' }) }))).toEqual([]);
    });
});

describe('story-contract — a finding’s groups are the server’s scope, not a revision match (U5, R3)', () => {
    it('resolves a scoped finding to exactly the groups it targets', () => {
        const groups = phraseGroups(midReview());
        const cross = finding({ id: 'f-cross', targeted: ['grp-promise', 'grp-theme'] });

        expect(findingGroups(cross, groups).map((row) => row.key)).toEqual(['promise', 'theme']);
        expect(findingTargetsGroup(cross, 'grp-tone', groups)).toBe(false);
    });

    it('resolves an UNSCOPED legacy finding against all five groups — the row a flat list used to hide', () => {
        const groups = phraseGroups(midReview());
        const wide = finding({ id: 'f-wide', group_refs: [], unscoped: true, targeted: [] });

        expect(findingGroups(wide, groups).map((row) => row.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        // …including a group that has no text yet: an unwritten group is exactly the one a whole-Overview
        // finding is still waiting on.
        expect(findingTargetsGroup(wide, 'grp-ending', groups)).toBe(true);
    });

    it('counts open findings per group, and splits them at the Summary’s own cost bar', () => {
        const view = midReview();

        expect(groupOpenFindings(view, 'grp-promise').map((row) => row.id)).toEqual([
            'f-cross',
            'f-wide',
            'f-minor'
        ]);
        expect(groupBlockingFindings(view, 'grp-promise').map((row) => row.id)).toEqual(['f-cross', 'f-wide']);
        // `auto_approve: ['critical','major']` on this Story, so the minor note is a note.
        expect(groupBlockingFindings(view, 'grp-premise').map((row) => row.id)).toEqual(['f-wide']);
        expect(groupOpenFindings(view, 'grp-nothing').map((row) => row.id)).toEqual([]);
    });

    it('authorises a minor note into the blocking set when the dial covers it', () => {
        const view = grouped({
            findings: [finding({ id: 'f-note', cost: 'minor', targeted: ['grp-tone'] })],
            review: { ...groupedPhraseView('s1').review, open_findings: 1, blocking_findings: 1 }
        });

        expect(summaryBlockingCost(view.story, 'minor')).toBe(false);
        expect(groupBlockingFindings(view, 'grp-tone')).toEqual([]);

        // The dial wide open: `minor` is inside `auto_approve`, so the note joins the blocking set.
        // The array carries `Cost[]` explicitly because the object spread drops the contextual type and
        // TS would otherwise widen the literals to `string[]`.
        const dialUp = {
            ...view,
            story: { ...view.story, auto_approve: ['critical', 'major', 'minor'] as Cost[] }
        };

        expect(summaryBlockingCost(dialUp.story, 'minor')).toBe(true);
        expect(groupBlockingFindings(dialUp, 'grp-tone').map((row) => row.id)).toEqual(['f-note']);
        // `taste` is never the Summary's cost, whatever the dial says.
        expect(summaryBlockingCost(dialUp.story, 'taste')).toBe(false);
    });

    it('keeps a fixed, disputed or discarded finding out of every active list (U5)', () => {
        const rows = [
            finding({ id: 'f-a', state: 'fixed' }),
            finding({ id: 'f-b', state: 'disputed' }),
            finding({ id: 'f-c', state: 'discarded' }),
            finding({ id: 'f-d', state: 'unconfirmed' }),
            finding({ id: 'f-e', state: 'confirmed' }),
            finding({ id: 'f-f', state: 'approved' })
        ];

        expect(rows.filter(isArchivedPhraseFinding).map((row) => row.id)).toEqual(['f-a', 'f-b', 'f-c']);

        const view = grouped({
            findings: [finding({ id: 'f-fixed', state: 'fixed', targeted: ['grp-theme'], cost: 'critical' })]
        });

        expect(groupOpenFindings(view, 'grp-theme')).toEqual([]);
        expect(groupBlockingFindings(view, 'grp-theme')).toEqual([]);
    });
});

describe('story-contract — a group’s history is a count, and its text is the current one (U3)', () => {
    it('counts the archived rows and never the `latest` one with them', () => {
        const premise = rowKeyed(fixturePhrase(), 'premise');

        expect(premise.history.map((row) => row.state)).toEqual(['latest', 'archived', 'archived']);
        expect(groupArchivedRevisions(premise).map((row) => row.number)).toEqual([2, 1]);
        expect(groupLatestRevision(premise)?.chars).toBe(74);
        expect(isGroupWritten(premise)).toBe(true);
    });

    it('treats `revision: 0` as never written, which is the loop’s own line (R1)', () => {
        const ending = rowKeyed(fixturePhrase(), 'ending');

        expect(isGroupWritten(ending)).toBe(false);
        expect(groupArchivedRevisions(ending)).toEqual([]);
        expect(groupLatestRevision(ending)).toBeUndefined();
        expect(unwrittenGroups(midReview()).map((row) => row.key)).toEqual(['ending']);
        expect(unwrittenGroups(grouped()).map((row) => row.key)).toEqual([]);
    });

    it('reads the Writer holding a group from the same field the route refuses with (R4, F8)', () => {
        expect(isGroupWriterBusy(rowKeyed(fixturePhrase(), 'theme'))).toBe(true);
        expect(isGroupWriterBusy(rowKeyed(fixturePhrase(), 'premise'))).toBe(false);
    });

    it('counts the open queue exactly as the projection sent it', () => {
        expect(groupOpenTasks(midReview()).map((row) => row.id)).toEqual(['t-theme', 't-ending']);
        expect(groupOpenTasks(grouped())).toEqual([]);
    });
});

describe('story-contract — the sign-off gate cannot claim a grouped book is ready (U5)', () => {
    it('says nothing for a clean grouped book, and nothing at all for a sampling one', () => {
        expect(groupSignOffBlockers(grouped())).toEqual([]);
        expect(groupSignOffBlockers(legacyView())).toEqual([]);
    });

    it('refuses on an unwritten group and names it by title, not by catalog key (R1, U6)', () => {
        const base = grouped();
        const unwrittenOnly = grouped({
            groups: base.phrase!.groups.map((row) =>
                row.key === 'ending' ? { ...row, content: '', revision: 0, updated_by: null, history: [] } : row
            ),
            review: { ...base.phrase!.review, written_groups: 4, unwritten_groups: ['ending'] }
        });

        expect(groupSignOffBlockers(unwrittenOnly)).toEqual([
            '1 Summary group still unwritten (Ending) — an unwritten group is not part of the Overview yet (R1)'
        ]);
    });

    it('refuses on an open finding at a blocking cost, and names the groups it spans', () => {
        const withCritical = grouped({
            findings: [finding({ id: 'f-1', targeted: ['grp-theme'] })],
            review: { ...groupedPhraseView('s1').review, open_findings: 1, blocking_findings: 1 }
        });

        expect(groupSignOffBlockers(withCritical)).toEqual([
            '1 open finding on the Summary groups — Theme still await your decision (D-34)'
        ]);

        // One the Author has already approved is a different wait: the fix is queued, the Author is done.
        const approved = grouped({
            findings: [finding({ id: 'f-2', state: 'approved', targeted: ['grp-theme'] })],
            review: { ...groupedPhraseView('s1').review, open_findings: 1, blocking_findings: 1 }
        });

        expect(groupSignOffBlockers(approved)).toEqual([
            '1 open finding on the Summary groups — Theme still await the revision that answers them (R3)'
        ]);

        // An UNSCOPED finding blocks the whole Overview, and the sentence says so by naming all five.
        const unscoped = grouped({
            findings: [finding({ id: 'f-3', unscoped: true, group_refs: [], targeted: [] })],
            review: { ...groupedPhraseView('s1').review, open_findings: 1, blocking_findings: 1 }
        });

        expect(groupSignOffBlockers(unscoped)).toEqual([
            '1 open finding on the Summary groups — Premise/Promise/Theme/Tone/Ending still await your decision (D-34)'
        ]);

        // A finding at a cost the dial tolerates is not a blocker, and the gate says nothing.
        const noteOnly = grouped({
            findings: [finding({ id: 'f-4', cost: 'minor', targeted: ['grp-theme'] })],
            review: { ...groupedPhraseView('s1').review, open_findings: 1, blocking_findings: 0 }
        });

        expect(groupSignOffBlockers(noteOnly)).toEqual([]);
    });

    it('refuses while the group queue still has work the crew has not closed', () => {        const withTask = grouped({
            tasks: [task({ id: 't-1' })],
            review: { ...groupedPhraseView('s1').review, open_tasks: 1 }
        });

        expect(groupSignOffBlockers(withTask)).toEqual([
            // R-T2/F3: the wire's task rows are every open task of the STORY (`projections.ts:1208`) and carry
            // no group attribution, so the sentence may not call them the groups'.
            '1 Story task still open in the queue — the crew has work it has not closed, on this Summary or anywhere in the Story'
        ]);
        // `claimed` and `in_progress` are as open as `open`; only `done` closes one (the projection's rule).
        const three = grouped({
            tasks: [
                task({ id: 't-1', state: 'open' }),
                task({ id: 't-2', state: 'claimed' }),
                task({ id: 't-3', state: 'done' })
            ],
            review: { ...groupedPhraseView('s1').review, open_tasks: 2 }
        });

        expect(groupSignOffBlockers(three)).toEqual([
            '2 Story tasks still open in the queue — the crew has work it has not closed, on this Summary or anywhere in the Story'
        ]);
    });

    it('refuses for an open task that belongs to no Summary group at all, and calls it what it is (R-T2/F3)', () => {
        // THE SERVER FACT this pins: `projections.ts:1208` builds the phrase read's task rows as
        // `store.tasks.list().filter(t => t.story_id === story.id && t.state !== 'done')` — EVERY open task of
        // the Story, whatever phase or kind — and `PhraseTaskRow` carries no group ids, so the client cannot
        // scope them. A chapter-repair task therefore holds the Summary sign-off on the real wire, and the
        // sentence has to say `Story task`; a copy that said `group task` would be describing a scope the read
        // never sent. Kept as a blocker because the engine also stops the phase while work is queued
        // (`loop/status.ts`: `${n} task(s) still queued`, and phase ①'s fix/rewrite/merge clause).
        const chapterRepair = grouped({
            tasks: [task({ id: 't-chapter', title: 'Repair the chapter point-of-view slip' })],
            review: { ...groupedPhraseView('s1').review, open_tasks: 1 }
        });

        expect(groupSignOffBlockers(chapterRepair)).toEqual([
            '1 Story task still open in the queue — the crew has work it has not closed, on this Summary or anywhere in the Story'
        ]);

        // And the same frame reaches the Author's one click.
        const gate = lockCheck(signOffFrame(chapterRepair));

        expect(gate.canLock).toBe(false);
        expect(gate.reasons).toContain(
            '1 Story task still open in the queue — the crew has work it has not closed, on this Summary or anywhere in the Story'
        );
    });

    it('refuses while the phrase read has not landed, and while it has failed (R-T2/F1, F2)', () => {
        // THE FRAME THE PROBE CAUGHT: a grouped Story at the Summary phase, Goal passing, Ideas empty, and no
        // phrase read. Every clause of the gate counts ROWS, and `phraseGroups` answers `[]` for a read that
        // has not landed, so the old gate reported zero reasons — a claim that a five-group Overview is
        // complete and clean, made by a desk that had never seen the groups. Absent groups are not an empty
        // valid Phrase.
        const inFlight = signOffFrame({ ...midReview(), phrase: undefined });

        expect(groupSignOffBlockers(inFlight)).toEqual([
            'the Summary group rows have not been read yet — the sign-off waits for the phrase read to answer'
        ]);

        const gate = lockCheck(inFlight);

        expect(gate.canLock).toBe(false);
        expect(gate.reasons).toHaveLength(1);
        expect(summaryReadyForReview(inFlight)).toBe(false);

        // A FAILED read is a different wait: the answer is not "hold on", it is the server's own sentence and
        // a reload. Same blocker, actionable wording (F2).
        const failed = signOffFrame({
            ...midReview(),
            phrase: undefined,
            phraseError: '503: the phrase read is offline (maintenance)'
        });

        expect(groupSignOffBlockers(failed)).toEqual([
            'the Summary group rows could not be read: 503: the phrase read is offline (maintenance) — reload the Story before signing the Summary off'
        ]);
        expect(lockCheck(failed).canLock).toBe(false);
        expect(summaryReadyForReview(failed)).toBe(false);

        // The same Story WITH its rows arriving answers differently again: the read blocker is gone and the
        // book's real waits are the ones listed (F1's "until actual groups arrive").
        const arrived = signOffFrame(midReview());

        expect(groupSignOffBlockers(arrived)).not.toContain(
            'the Summary group rows have not been read yet — the sign-off waits for the phrase read to answer'
        );
        expect(summaryReadyForReview(arrived)).toBe(false);
    });

    it('refuses while a Writer is holding a group, because the text on screen is about to move (R4)', () => {
        const base = grouped();
        const busy = grouped({
            groups: base.phrase!.groups.map((row) => (row.key === 'theme' ? { ...row, writer_busy: true } : row))
        });

        expect(groupSignOffBlockers(busy)).toEqual([
            'the Writer is rewriting Theme right now — the text on screen is about to move (R4)'
        ]);

        const allBusy = grouped({
            groups: base.phrase!.groups.map((row) => ({ ...row, writer_busy: true }))
        });

        expect(groupSignOffBlockers(allBusy)).toEqual([
            'the Writer is rewriting Premise, Promise, Theme, Tone, Ending right now — the text on screen is about to move (R4)'
        ]);
    });

    it('lists every kind of blocker at once when the mid-review book is asked about', () => {
        expect(groupSignOffBlockers(midReview())).toEqual([
            '1 Summary group still unwritten (Ending) — an unwritten group is not part of the Overview yet (R1)',
            '2 open findings on the Summary groups — Promise/Theme, Premise/Promise/Theme/Tone/Ending still await your decision (D-34)',
            '2 Story tasks still open in the queue — the crew has work it has not closed, on this Summary or anywhere in the Story',
            'the Writer is rewriting Theme right now — the text on screen is about to move (R4)'
        ]);
    });

    it('reaches the phase gate, which is the surface the Author clicks', () => {
        const gate = lockCheck(signOffFrame(midReview()));

        expect(gate.canLock).toBe(false);
        // The gate's whole reason list IS the group list here: Goal passing and Ideas empty, and a grouped
        // book never runs the sampler's clauses (no "no Summary revision on record" over a written
        // five-group Overview).
        expect(gate.reasons).toEqual(groupSignOffBlockers(signOffFrame(midReview())));
        expect(gate.reasons).toHaveLength(4);

        const clean = lockCheck(signOffFrame(grouped()));

        expect(clean.canLock).toBe(true);
        expect(clean.reasons).toEqual([]);
        expect(clean.statement).toBe(
            'Locking the Summary makes it read-only for every agent (P5, L-30) and deletes this phase\u2019s Ideas tray in the same commit (D-36).'
        );
    });

    it('leaves the sampling gate exactly as it was (U1, U3)', () => {
        const sampling = signOffFrame(fixtureView());

        expect(sampling.phrase).toBeUndefined();
        // The sampling Summary keeps its own clause set (drafts in the round, the deep-review pass), and
        // the group bar contributes nothing to a book with no group rows.
        expect(groupSignOffBlockers(sampling)).toEqual([]);
        expect(lockCheck(sampling).reasons.some((reason) => reason.includes('Summary group'))).toBe(false);
        expect(lockCheck(sampling).reasons.some((reason) => reason.includes('group task'))).toBe(false);
        // The sampler's own vocabulary is still there for the book that runs the sampler.
        expect(
            lockCheck(sampling).reasons.some(
                (reason) => reason.includes('Summary revision') || reason.includes('deep-review')
            )
        ).toBe(true);
    });
});

/** A book with no phrase read and no `summary_mode`: the payload this workspace shipped before R6. */
function legacyView() {
    return fixtureView();
}

// ---------------------------------------------------------------------------
// T3 — the two fields the wire added: the SCORE a pass writes against each group, and the CLAIM TYPE a finding
// carries.
//
// Both rules live in this module rather than in the rail and the pane, because three surfaces answer from the
// same `PhraseGroupRow.scores` array — a group row's percentage, the phrase header's average and the pane's
// trail — and a rule that is a function of the row is pinnable without a DOM. The facts pinned below are the
// ones a surface could silently get wrong: the order of the trail, what absence means, whether a scored-zero
// group counts toward the average, and which of the wire's three kind spellings is a Proposal.
// ---------------------------------------------------------------------------
describe('story-contract — the group’s score trail (T3)', () => {
    /** One scoring pass, in the shape the projection sends it. */
    function pass(value: number, at: string, hash = 'vh-1'): PhraseGroupScore {
        return { value, vector_hash: hash, at, run_ref: `run_critic_${hash}` };
    }

    /** A group row whose `scores` are exactly the passes a case needs (`undefined` = the key is absent). */
    function scoredGroup(scores: PhraseGroupScore[] | undefined): PhraseGroupRow {
        // Ending is the fixture's unscored row, so the spread cannot smuggle a stale `scores` in.
        const row = rowKeyed(fixturePhrase(), 'ending');

        return { ...row, ...(scores === undefined ? {} : { scores }) };
    }

    it('reads the Author’s percentage from either spelling, and clamps what overshoots the scale', () => {
        // `0.84` and `84` are the same claim in two notations, and `1` is the fraction's top, not one percent.
        // A value off the end of the scale is clamped rather than printed: `118%` on a 320px rail is a bug
        // pretending to be a score, and a negative is the same claim upside down.
        expect(
            [0.84, 84, 1, 0, 0, 84.6, 118, -5].map((value) => phraseScorePercent(value))
        ).toEqual([84, 84, 100, 0, 0, 85, 100, 0]);
    });

    it('drops a pass whose value is not a number instead of printing `NaN%`', () => {
        const group = scoredGroup([pass(Number.NaN, '2026-11-09T12:00:00.000Z', 'vh-3'), pass(70, '2026-11-08T12:00:00.000Z', 'vh-2'), pass(Number.POSITIVE_INFINITY, '2026-11-07T12:00:00.000Z', 'vh-1')]);

        // Only the finite row survives, so the newest real pass is 70 and there is nothing before it.
        expect(groupScores(group)).toEqual([pass(70, '2026-11-08T12:00:00.000Z', 'vh-2')]);
        expect(groupScorePercent(group)).toBe(70);
        expect(groupPreviousScorePercent(group)).toBeUndefined();
    });

    it('orders the trail newest first whatever order the wire sent it in', () => {
        // `scores[0]` being the latest pass is the difference between "84% (was 78%)" and the same pair
        // printed backwards, so the read does not trust the payload's ordering.
        const group = scoredGroup([
            pass(71, '2026-11-05T12:00:00.000Z', 'vh-a'),
            pass(84, '2026-11-09T12:00:00.000Z', 'vh-c'),
            pass(78, '2026-11-01T12:00:00.000Z', 'vh-b')
        ]);

        expect(groupScores(group).map((row) => [row.value, row.at])).toEqual([
            [84, '2026-11-09T12:00:00.000Z'],
            [71, '2026-11-05T12:00:00.000Z'],
            [78, '2026-11-01T12:00:00.000Z']
        ]);
        expect(groupLatestScore(group)?.vector_hash).toBe('vh-c');
        expect(groupPreviousScore(group)?.vector_hash).toBe('vh-a');
    });

    it('answers absence with absence: no key, an empty list, and a scored zero are three different states', () => {
        expect(groupScores(scoredGroup(undefined))).toEqual([]);
        expect(groupScores(scoredGroup([]))).toEqual([]);
        expect(groupScorePercent(scoredGroup(undefined))).toBeUndefined();
        expect(groupScorePercent(scoredGroup([]))).toBeUndefined();
        // A group the pass rated 0 HAS been rated — the rail prints `0%`, it does not hide the worst number.
        expect(groupScorePercent(scoredGroup([pass(0, '2026-11-09T12:00:00.000Z')]))).toBe(0);
        // One pass has no previous, and that is not the same as a previous of zero.
        expect(groupPreviousScore(scoredGroup([pass(50, '2026-11-09T12:00:00.000Z')]))).toBeUndefined();
    });

    it('takes each group’s latest and previous percentages from the fixture’s two passes', () => {
        const phrase = fixturePhrase();
        const percentOf = (key: string) => [
            groupScorePercent(rowKeyed(phrase, key)),
            groupPreviousScorePercent(rowKeyed(phrase, key))
        ];

        // Premise 78→84 and Promise 55→62 are the improvements, Tone 64→58 is the rewrite that went backwards,
        // Theme has ONE pass (so no previous), and Ending has never been scored.
        expect(percentOf('premise')).toEqual([84, 78]);
        expect(percentOf('promise')).toEqual([62, 55]);
        expect(percentOf('theme')).toEqual([71, undefined]);
        expect(percentOf('tone')).toEqual([58, 64]);
        expect(percentOf('ending')).toEqual([undefined, undefined]);
    });

    it('averages the phrase only when every group carries a score, and rounds once', () => {
        // `groupedPhraseView` scores all five in one pass: 84 + 76 + 70 + 88 + 66 = 384, /5 = 76.8 → 77.
        expect(phraseOverallScore(grouped())).toBe(77);
        // The fixture book has one UNSCORED group (Ending, no `scores` key), so its header prints nothing:
        // the mean of the four rows that happened to arrive is a number the server never claimed.
        expect(phraseOverallScore(midReview())).toBeUndefined();
        // A sampling-mode book has no group rows at all, and a book whose read has not landed either.
        expect(phraseOverallScore(legacyView())).toBeUndefined();
        expect(phraseOverallScore(grouped({ groups: [] }))).toBeUndefined();
        // A group whose only pass is malformed is an unscored group, and it silences the average the same way.
        const rows = groupedPhraseView('s1').groups.map((row) =>
            row.key === 'ending' ? { ...row, scores: [pass(Number.NaN, '2026-11-09T12:00:00.000Z')] } : row
        );

        expect(phraseOverallScore(grouped({ groups: rows }))).toBeUndefined();
        // A zero counts: it is a verdict, not an absence. (0+100+0+100+0)/5 = 40.
        const spread = groupedPhraseView('s1').groups.map((row, index) => ({
            ...row,
            scores: [pass(index % 2 === 0 ? 0 : 100, '2026-11-09T12:00:00.000Z')]
        }));

        expect(phraseOverallScore(grouped({ groups: spread }))).toBe(40);
        // …and the mean is taken over the unrounded percents and rounded ONCE: 80.5 goes up, to 81.
        const tie = groupedPhraseView('s1').groups.slice(0, 2).map((row, index) => ({
            ...row,
            scores: [pass(index === 0 ? 80 : 81, '2026-11-09T12:00:00.000Z')]
        }));

        expect(phraseOverallScore(grouped({ groups: tie }))).toBe(81);
    });
});

describe('story-contract — what a finding claims (T3)', () => {
    it('names both claim types, and defaults every other token to an Issue', () => {
        const cases: Array<[string | undefined, 'Issue' | 'Proposal']> = [
            ['issue', 'Issue'],
            ['proposal', 'Proposal'],
            // The token mid-rename: a payload from the other side of it still means a Proposal, and a surface
            // that switched on the new spelling alone would render every improvement as a defect.
            ['improvement', 'Proposal'],
            [undefined, 'Issue'],
            ['', 'Issue'],
            // No trimming, no fuzzy matching: an unknown token is the default claim, never a proposal the
            // desk was not told about.
            ['issue ', 'Issue'],
            ['Proposal', 'Issue'],
            ['weird', 'Issue']
        ];

        expect(cases.map(([kind]) => findingKindLabel(kind))).toEqual(cases.map(([, label]) => label));
        // The style hook carries the SAME decision in the lowercase form the stylesheet keys on, so a surface
        // cannot colour a label its own text says differently.
        expect(cases.map(([kind]) => findingKindToken(kind))).toEqual(
            cases.map(([, label]) => (label === 'Proposal' ? 'proposal' : 'issue'))
        );
    });
});

describe('story-contract — the Reviewed Summary’s decisions (D-67, D-68)', () => {
    /** One of the four reviewed frames, wrapped in the view shape the selectors read. */
    function reviewed(state: 'pending' | 'ready' | 'chosen' | 'stale' | 'writer_busy') {
        return fixtureView({ phrase: reviewedPhraseView('s1', state) });
    }

    it('prints the reviewed Overview in `ready`, the chosen text in `chosen`, and NOTHING in `pending`', () => {
        // D-67's whole rule lives in this one function: `pending` returns `''` rather than the live composed
        // Overview, which is what stops an unreviewed sentence standing under a heading that says it was read.
        const ready = reviewed('ready');

        expect(reviewedSummaryText(ready)).toContain('Ending — the clean text the Reviewers passed at Revision 2.');
        expect(reviewedSummaryText(ready)).not.toContain('the newest text the Writer installed');
        expect(reviewedSummaryText(reviewed('stale'))).toContain(
            'Ending — the clean text the Reviewers passed at Revision 2.'
        );
        expect(reviewedSummaryText(reviewed('chosen'))).toBe(
            [
                'Premise — the text the Author chose.',
                'Promise — the text the Author chose.',
                'Theme — the text the Author chose.',
                'Tone — the text the Author chose.',
                'Ending — the text the Author chose.'
            ].join('\n\n')
        );
        // The waiting frame has no Summary text at all, even though the live Overview is full of it.
        const waiting = reviewed('pending');

        expect(reviewedSummaryText(waiting)).toBe('');
        expect(waiting.phrase?.overview).not.toBe('');
    });

    it('reports `stale` as a `ready` selection with a recorded choice, and never as a state of its own', () => {
        const frame = reviewed('stale');

        // The tab's branch token is `ready`: `stale` rides BESIDE it (the projection computes the state that
        // way), so a pane that branched on a third token would draw a frame the server never sends.
        expect(reviewedState(frame)).toBe('ready');
        const stale = phraseReviewed(frame);

        expect(stale.state).toBe('ready');
        expect(stale.stale).toBe(true);
        expect(stale.chosen).not.toBeNull();
        // The fixture is coherent the way the projection is: the chosen hash is NOT the live selection's,
        // which is the only reason `stale` is true. A fixture that faked the token would teach the pane a
        // state the server cannot send.
        expect(stale.chosen?.vector_hash).toBe('vh-chosen-1');
        expect(stale.vector_hash).toBe('vh-clean-1');
        // `ready` without a choice, and `chosen` with one: the two are decided by the hash comparison the
        // server makes, not by a flag this file could invent.
        const ready = phraseReviewed(reviewed('ready'));

        expect(ready.chosen).toBeNull();
        expect(ready.stale).toBe(false);
        expect(reviewedState(reviewed('chosen'))).toBe('chosen');
    });

    it('says why each group is missing, one sentence per wire token, and none for a selected group', () => {
        // Four different waits, four different sentences. `issues_open` outranks `no_clean_revision` because
        // the finding is what the Author can actually act on.
        expect(
            reviewedGaps(reviewed('pending')).map((row) => [row.reviewed.key, row.reason])
        ).toEqual([
            ['promise', 'has open issues'],
            ['theme', 'nothing written yet'],
            ['tone', 'awaiting a clean pass']
        ]);
        // A selected group has no reason, whatever else is going on around it.
        const waiting = reviewed('pending');

        expect(reviewedGapReason(waiting.phrase?.reviewed?.groups[0] as never)).toBe('');
        // An unknown gap token is reported as itself rather than guessed away: the pane may not invent a
        // reason the wire did not send.
        expect(
            reviewedGapReason({ gap: 'retired', issues_open: false, selected_revision: null } as never)
        ).toBe('awaiting a clean pass (retired)');
    });

    it('names the unresolved issues holding a clean pass back, by group TITLE rather than by key', () => {
        expect(reviewedBlockingIssues(reviewed('pending'))).toEqual([
            {
                id: 'f-clean-block',
                title: 'the promise names a cost the premise never sets up',
                cost: 'major',
                groups: ['Promise']
            }
        ]);
        expect(reviewedBlockingIssues(reviewed('ready'))).toEqual([]);
    });

    it('keeps the Choose offered while the crew has reviewed past the Author’s choice, and shuts it for the wire’s two reasons', () => {
        const bound = true;

        // The deviation the pane depends on: `stale` never disables. An Author who already chose once has to
        // be able to take the NEWER reviewed text, which is the case the route exists for a second time.
        expect(reviewedChooseRefusal(reviewed('ready'), bound)).toBe('');
        expect(reviewedChooseRefusal(reviewed('stale'), bound)).toBe('');
        expect(reviewedChooseRefusal(reviewed('writer_busy'), bound)).toBe(
            'The Writer is rewriting part of this Summary right now, so choosing would install under a pass that has not finished (R4).'
        );
        // The missing binding is the shell's own refusal, and it outranks everything: a click on an unbound
        // verb would do nothing at all.
        expect(reviewedChooseRefusal(reviewed('writer_busy'), false)).toBe(
            'The reviewed-Summary choose route is not available in this shell.'
        );
        expect(reviewedChooseRefusal(reviewed('ready'), false)).toBe(
            'The reviewed-Summary choose route is not available in this shell.'
        );
    });

    it('joins each reviewed row to the score that judged the CLEAN vector, not the live rows’ pass', () => {
        // The two lists carry DIFFERENT numbers on purpose (79/71/66/83/62 for `vh-clean-1`, 84/76/70/88/66
        // for the live `vh-9` pass), so a wrong join is visible rather than plausible.
        expect(
            reviewedGroupRows(reviewed('ready')).map((row) => [row.title, row.score, row.superseded])
        ).toEqual([
            ['Premise', 79, false],
            ['Promise', 71, false],
            ['Theme', 66, false],
            ['Tone', 83, false],
            ['Ending', 62, true]
        ]);
        // A partial selection carries a hash no score row claims, so the rows print without numbers rather
        // than borrowing the live pass.
        expect(reviewedGroupRows(reviewed('pending')).map((row) => row.score)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined
        ]);
        // And the drop the confirmation step names is exactly the superseded set.
        expect(reviewedSupersededGroups(reviewed('ready')).map((row) => [row.title, row.reviewed.latest_revision])).toEqual([
            ['Ending', 3]
        ]);
        expect(reviewedSupersededGroups(reviewed('pending'))).toEqual([]);
    });

    it('passes the choose’s refusal through untouched, and reads absence as absence', () => {
        // The sentence is the Author's next action, so this layer may not reword, trim or default it.
        const refusal =
            'the Writer is rewriting part of this Summary right now (run_write_groups_1), so choosing the reviewed Overview would install under a pass that has not finished — the same choice lands once those runs close (R4, D-68).';

        expect(reviewedChooseError({ reviewedError: refusal })).toBe(refusal);
        expect(reviewedChooseError({ reviewedError: null })).toBeUndefined();
        expect(reviewedChooseError({})).toBeUndefined();
    });
});
