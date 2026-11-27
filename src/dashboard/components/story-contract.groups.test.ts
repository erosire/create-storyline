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
// T13 / R2 changed WHICH facts the sign-off gate treats as waits, and the block that owns that rule is
// `the clean Summary the Accept control hangs on` below. In one line: the Summary accept opens when a CLEAN
// Summary exists (a complete reviewed selection, or the one the Author chose); open Critic findings and open
// queue tasks are no longer blockers — they are counted into the sentence the control prints under itself,
// because the accept voids the findings and closes the tasks. The Goal (U-16), the Ideas tray (L-7a), the
// phrase read and a live Writer (R4) still hold it shut, and an incomplete selection answers with ONE
// gap-naming reason rather than the old findings/task list.
//
// D-67/D-68 add a second set of those rules — WHICH text the Summary tab prints, which number belongs beside
// it, why a group is missing from the reviewed Overview, and when the Author may choose it. The pane tests
// render the sentences; this suite pins the decisions underneath them, because a second surface (the rail, a
// future panel) has to reach the same answers from the same wire.
import { describe, expect, it } from 'vitest';

import {
    ACCEPT_SWEPT_TASK_STATES,
    ACCEPT_VOIDED_FINDING_STATES,
    cleanSummaryExists,
    cleanSummaryGateReason,
    findingGroups,
    findingKindLabel,
    findingKindToken,
    findingTargetsGroup,
    groupArchivedRevisions,
    groupBlockingFindings,
    groupFindingsVoidedByAccept,
    groupLatestRevision,
    groupLatestScore,
    groupOpenFindings,
    groupOpenTasks,
    groupPreviousScore,
    groupPreviousScorePercent,
    groupScorePercent,
    groupScores,
    groupSignOffBlockers,
    groupTasksClosedByAccept,
    groupTasksLeftByAccept,
    isArchivedPhraseFinding,
    isGroupSummary,
    isGroupWritten,
    isGroupWriterBusy,
    isOpenPhraseFinding,
    lockCheck,
    OPEN_TASK_STATES,
    phraseFindings,
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
    summaryAcceptLeftovers,
    summaryBlockingCost,
    unwrittenGroups
} from './story-contract';
import { fixtureGoal, fixtureIdeas, fixturePhrase, fixtureView } from '../testing/story-fixtures';
// R-T2/F1: the rail's ready tick and the Accept button are the SAME fact, and the regression below asserts
// both, so the nav module's derivation is under test here as well as the contract's blocker list.
import { summaryReadyForReview } from './story-nav';
import { groupedPhraseView, reviewedPhraseView } from '../testing/shell-fakes';
import type { StoryViewData } from './story-contract';
import type { PhraseFindingRow, PhraseGroupRow, PhraseGroupScore, PhraseTaskRow, PhraseView } from '../api';
import type { Cost } from '../../types';
import type { Story } from '../../types';

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

/**
 * The five group ids of `groupedPhraseView`, in composition order. An UNSCOPED row's `targeted` carries all of
 * them (`findingGroupScope` reads "no groups named" as "every group of this Story"), which is why the unscoped
 * fixture below sends the full list rather than an empty one.
 */
const GROUP_IDS = ['grp-premise', 'grp-promise', 'grp-theme', 'grp-tone', 'grp-ending'];

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

    it('counts the open queue on the engine’s own unfinished set, closes `wontfix` with `done`, and splits the set the accept sweeps (T13, U-16)', () => {
        // The two closed states in the store (`shared/types.ts:171 TASK_STATES`) are `done` AND `wontfix`; the
        // gate used to ask `state !== 'done'`, which left a task the crew DECLINED holding the Accept button
        // forever. `OPEN_TASK_STATES` is the desk's mirror of the WIRE's queue set —
        // `projections.ts:OPEN_TASK_STATES`, which `phraseProjection`'s `openTasks` filters the read's `tasks`
        // rows and `review.open_tasks` by.
        expect(OPEN_TASK_STATES).toEqual(['open', 'claimed', 'blocked']);

        // The mid-review book: `claimed` + `open` are open, `done` is not.
        expect(groupOpenTasks(midReview()).map((row) => row.id)).toEqual(['t-theme', 't-ending']);
        expect(groupOpenTasks(grouped())).toEqual([]);

        // Every state, one row each, in the order the read sent them.
        const everyState = grouped({
            tasks: [
                task({ id: 't-open', state: 'open' }),
                task({ id: 't-claimed', state: 'claimed' }),
                task({ id: 't-blocked', state: 'blocked' }),
                task({ id: 't-done', state: 'done' }),
                task({ id: 't-wontfix', state: 'wontfix' })
            ]
        });

        expect(groupOpenTasks(everyState).map((row) => row.id)).toEqual(['t-open', 't-claimed', 't-blocked']);

        // THE SECOND, NARROWER SET — what the accept's own commit moves: `loop/records.ts:wontfixTasks` walks
        // `loop/records.ts:openTasks`, which filters `loop/types.ts:OPEN_TASK_STATES` (`open`/`claimed`). A
        // `blocked` row is in the queue and OUT of the sweep, because it is the crew's question to the Author
        // and an accept is not an answer to it, so it survives the click. The statement has to count these two
        // numbers apart — the case in the gate block below pins the sentence.
        expect(ACCEPT_SWEPT_TASK_STATES).toEqual(['open', 'claimed']);
        expect(groupTasksClosedByAccept(everyState).map((row) => row.id)).toEqual(['t-open', 't-claimed']);
        expect(groupTasksLeftByAccept(everyState).map((row) => row.id)).toEqual(['t-blocked']);
        // The two clauses together are the queue, so no open row goes uncounted by one of them: a `blocked`
        // row may not be dropped from the sentence just because the sweep skips it.
        expect(groupTasksClosedByAccept(everyState).length + groupTasksLeftByAccept(everyState).length).toBe(
            groupOpenTasks(everyState).length
        );
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

    it('refuses on an unwritten group and names it by title, not by catalog key (R1, U6)', () => {
        const base = grouped();
        const unwrittenOnly = grouped({
            groups: base.phrase!.groups.map((row) =>
                row.key === 'ending' ? { ...row, content: '', revision: 0, updated_by: null, history: [] } : row
            ),
            review: { ...base.phrase!.review, written_groups: 4, unwritten_groups: ['ending'] },
            // THE WIRE AGREEING WITH ITSELF: a group with no revision row has no Clean revision to select
            // (`reviewed.ts:cleanSelectionOf` pushes the `unwritten` gap for exactly that), so the reviewed
            // block is `pending` here with Ending's own row carrying the gap — rather than the fixture default,
            // which would claim a complete selection over a five-group Overview with a hole in it.
            reviewed: {
                ...base.phrase!.reviewed,
                state: 'pending' as const,
                complete: false,
                groups: base.phrase!.reviewed.groups.map((row) =>
                    row.key === 'ending'
                        ? { ...row, selected_revision: null, selected_id: null, clean_run_ref: null, gap: 'unwritten' as const }
                        : row
                )
            }
        });

        expect(groupSignOffBlockers(unwrittenOnly)).toEqual([
            '1 Summary group still unwritten (Ending) — an unwritten group is not part of the Overview yet (R1)'
        ]);

        // R2's no-duplicate rule: the missing selection IS the unwritten group, so the gate says it ONCE. The
        // gap row the read carries (`Ending: nothing written yet`) is dropped out of the clean-Summary sentence
        // because R1's bullet already names it, and with nothing left to name the sentence is not emitted.
        expect(cleanSummaryExists(unwrittenOnly)).toBe(false);
        expect(cleanSummaryGateReason(unwrittenOnly)).toBe('');
    });

    it('no longer refuses on an open finding: the accept voids it, and the statement counts it (R2, L-36, L-25b)', () => {
        // THE RULE THIS REPLACES. This control used to grey out over a finding at a blocking cost, which asked
        // the Author to settle a defect the click settles (L-36: "an unapproved finding does not halt a Story by
        // itself … a pending decision, not a blocked Story"). The row is NOT invisible — it is the count in the
        // statement the Author reads before pressing — it is simply no longer a door.
        const withCritical = grouped({
            findings: [finding({ id: 'f-1', targeted: ['grp-theme'] })],
            review: { ...groupedPhraseView('s1').review, open_findings: 1, blocking_findings: 1 }
        });

        expect(groupSignOffBlockers(withCritical)).toEqual([]);
        expect(lockCheck(signOffFrame(withCritical))).toMatchObject({ canLock: true, reasons: [] });
        expect(summaryAcceptLeftovers(withCritical)).toEqual({ findings: 1, tasks: 0, blocked: 0 });

        // The three states the old copy spelled apart (`confirmed`, `approved`, unscoped over all five) now
        // reach the SAME answer, which is the point: none of them is a wait for this control.
        const approved = grouped({
            findings: [finding({ id: 'f-2', state: 'approved', targeted: ['grp-theme'] })],
            review: { ...groupedPhraseView('s1').review, open_findings: 1, blocking_findings: 1 }
        });

        expect(groupSignOffBlockers(approved)).toEqual([]);
        expect(summaryAcceptLeftovers(approved)).toEqual({ findings: 1, tasks: 0, blocked: 0 });

        const unscoped = grouped({
            findings: [finding({ id: 'f-3', unscoped: true, group_refs: [], targeted: [] })],
            review: { ...groupedPhraseView('s1').review, open_findings: 1, blocking_findings: 1 }
        });

        expect(groupSignOffBlockers(unscoped)).toEqual([]);
        expect(summaryAcceptLeftovers(unscoped)).toEqual({ findings: 1, tasks: 0, blocked: 0 });

        // A finding at a cost the dial tolerates never joined the blocking set, and it never gated this control.
        // It IS still an open row the accept voids: the clause counts the phrase's OPEN rows, which is the number
        // `review.open_findings` sends and the Overview's own status line prints, so the two surfaces never show
        // different books of the same rows.
        const noteOnly = grouped({
            findings: [finding({ id: 'f-4', cost: 'minor', targeted: ['grp-theme'] })],
            review: { ...groupedPhraseView('s1').review, open_findings: 1, blocking_findings: 0 }
        });

        expect(groupSignOffBlockers(noteOnly)).toEqual([]);
        expect(summaryAcceptLeftovers(noteOnly)).toEqual({ findings: 1, tasks: 0, blocked: 0 });
    });

    it('no longer refuses while the queue has work, and counts what the accept closes (R2, L-25b)', () => {
        const withTask = grouped({
            tasks: [task({ id: 't-1' })],
            review: { ...groupedPhraseView('s1').review, open_tasks: 1 }
        });

        expect(groupSignOffBlockers(withTask)).toEqual([]);
        expect(lockCheck(signOffFrame(withTask))).toMatchObject({ canLock: true, reasons: [] });
        expect(summaryAcceptLeftovers(withTask)).toEqual({ findings: 0, tasks: 1, blocked: 0 });

        // AC2 — one row per state. The QUEUE counts `open`/`claimed`/`blocked`, and the GATE waits for none of
        // them (R2); what the accept CLOSES is only `open`/`claimed`, with `blocked` named as what it leaves
        // (U-16), and `done`/`wontfix` are settled work that neither clause may name.
        const five = grouped({
            tasks: [
                task({ id: 't-1', state: 'open' }),
                task({ id: 't-2', state: 'claimed' }),
                task({ id: 't-3', state: 'blocked' }),
                task({ id: 't-4', state: 'done' }),
                task({ id: 't-5', state: 'wontfix' })
            ]
        });

        expect(groupSignOffBlockers(five)).toEqual([]);
        expect(summaryAcceptLeftovers(five)).toEqual({ findings: 0, tasks: 2, blocked: 1 });

        // THE DEFECT THIS REMOVES, at the surface the Author reads: a `wontfix` row used to grey the control
        // (the filter asked only for `!== 'done'`), so a book whose crew had DECLINED the work could never be
        // signed off. It is enabled, and the declined task is not even named as something to close.
        const declined = grouped({ tasks: [task({ id: 't-5', state: 'wontfix' })] });

        expect(lockCheck(signOffFrame(declined))).toMatchObject({ canLock: true, reasons: [] });
        expect(summaryAcceptLeftovers(declined)).toEqual({ findings: 0, tasks: 0, blocked: 0 });
    });

    it('counts only the rows the sweep moves, and says out loud what it leaves for the Author (U-16)', () => {
        // THE NUMERIC MISMATCH this pins. The route's accept sweeps `open` + `claimed` and reports that number
        // on `lock_receipt.wontfixed_tasks` (`loop/records.ts:wontfixTasks` over
        // `loop/types.ts:OPEN_TASK_STATES`); the desk's queue read is three states wide
        // (`projections.ts:OPEN_TASK_STATES`, the mirror of `OPEN_TASK_STATES` above), so the old line could
        // promise "closes 3 open tasks … as wontfix" over a receipt answering 2. §10.2's U-16: a line naming a
        // leftover this book does not have is the same lie as a blocker that is not one. THE GATE IS
        // UNCHANGED — an open task of any state, `blocked` included, is still not a blocker (D-78).
        const mixed = grouped({
            findings: [finding({ id: 'f-1', targeted: ['grp-theme'] })],
            tasks: [
                task({ id: 't-open', state: 'open' }),
                task({ id: 't-claimed', state: 'claimed' }),
                task({ id: 't-blocked', state: 'blocked' }),
                task({ id: 't-blocked-2', state: 'blocked' }),
                task({ id: 't-done', state: 'done' }),
                task({ id: 't-wontfix', state: 'wontfix' })
            ],
            review: { ...groupedPhraseView('s1').review, open_findings: 1, open_tasks: 4 }
        });

        // EACH ROW, accounted for: swept (2), left standing (2 blocked), or already settled and named by
        // neither clause (`done`, `wontfix`).
        expect(groupTasksClosedByAccept(mixed).map((row) => row.id)).toEqual(['t-open', 't-claimed']);
        expect(groupTasksLeftByAccept(mixed).map((row) => row.id)).toEqual(['t-blocked', 't-blocked-2']);
        expect(summaryAcceptLeftovers(mixed)).toEqual({ findings: 1, tasks: 2, blocked: 2 });
        // The QUEUE number the Overview prints is still the wider one — proof the statement stopped borrowing it.
        expect(groupOpenTasks(mixed).map((row) => row.id)).toEqual([
            't-open',
            't-claimed',
            't-blocked',
            't-blocked-2'
        ]);

        const gate = lockCheck(signOffFrame(mixed));

        expect(gate.canLock).toBe(true);
        expect(gate.reasons).toEqual([]);
        // THE WHOLE SENTENCE, every conditional clause at once, in the order the acts happen.
        expect(gate.statement).toBe(
            'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
                ', voids 1 open finding on the Summary phrase, closes 2 open tasks in the queue as wontfix,' +
                ' leaves 2 blocked tasks for you, and starts Phrase 2 from the compiled Summary (D-72).'
        );
        // THE OVERSTATEMENT IT CAN NO LONGER MAKE: the read carries 6 queue rows and the queue is 4 open rows
        // wide, and neither number may appear in the "closes" clause — only the 2 the sweep moves.
        expect(gate.statement).not.toContain('closes 4 open tasks');
        expect(gate.statement).not.toContain('closes 6 open tasks');

        // THE CLAUSES ARE CONDITIONAL, each on its own: with no blocked row the "leaves" clause is absent (the
        // mid-review book's line, pinned above), and with ONLY a blocked row the "closes" clause is absent
        // while the "leaves" clause still names what survives — nothing goes quietly out of the sentence.
        const blockedOnly = lockCheck(signOffFrame(grouped({ tasks: [task({ id: 't-blocked', state: 'blocked' })] })));

        expect(blockedOnly.canLock).toBe(true);
        expect(blockedOnly.reasons).toEqual([]);
        expect(blockedOnly.statement).toBe(
            'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
                ', leaves 1 blocked task for you, and starts Phrase 2 from the compiled Summary (D-72).'
        );
    });

    it('voids every claim the sweep discards — the findings twin of the swept-tasks fix (D-78, D-33c)', () => {
        // THE DEFECT, in the same sentence's other half. The confirm line's findings count used to be the
        // Overview's REVIEW band (`OPEN_PHRASE_FINDING_STATES` / `review.open_findings`: `unconfirmed`,
        // `confirmed`, `approved`), but the act it describes is `phrase/locks.ts:voidFindingsOnLock` over
        // `VOIDABLE_FINDING_STATES`, which also takes `disputed` — D-33c counts a dispute as a live claim about
        // text that has just stopped being writable. Observed live: a five-state fixture the desk booked as 3
        // while the sweep discarded 4, and a real frame reading "voids 1 open finding" over a receipt answering
        // `voided_findings: 2`. The sweep's own numbers are pinned server-side in `loop/lock-accept.test.ts`
        // (the eight-row book, `voided_findings: 4`), and this is the desk book of the SAME rows.
        //
        // THE BOOK, as the Summary phrase read sends it: one row in every state §4.10's ladder has, one claim
        // scoped to a group and one UNSCOPED legacy claim, and every scoped ref is one of this phrase's entries.
        const five = grouped({
            findings: [
                // The legacy "the Overview as a whole" claim: `findingGroupScope` resolves it to all five
                // entries, which is why the read sends `targeted` filled in even though the row named none.
                finding({ id: 'f-unconf', state: 'unconfirmed', cost: 'major', group_refs: [], unscoped: true, targeted: GROUP_IDS }),
                finding({ id: 'f-conf', state: 'confirmed', cost: 'critical', targeted: ['grp-premise'] }),
                // A cost the dial tolerates: in the void, out of the review band's blocking half.
                finding({ id: 'f-appr', state: 'approved', cost: 'minor', targeted: ['grp-theme'] }),
                finding({ id: 'f-disp', state: 'disputed', cost: 'major', targeted: ['grp-tone'] }),
                // The two terminal rows: §4.10 leaves them exactly where they are, so neither may be counted.
                finding({ id: 'f-fixed', state: 'fixed', cost: 'critical', targeted: ['grp-promise'] }),
                finding({ id: 'f-disc', state: 'discarded', cost: 'critical', targeted: ['grp-ending'] })
            ],
            review: { ...groupedPhraseView('s1').review, open_findings: 3, blocking_findings: 2 }
        });

        // THE CONSTANT, pinned against `phrase/locks.ts:VOIDABLE_FINDING_STATES` — four states, one more than
        // the review band, and the only reason this file needs it is that the two lists answer different questions.
        expect(ACCEPT_VOIDED_FINDING_STATES).toEqual(['unconfirmed', 'confirmed', 'approved', 'disputed']);
        // EACH ROW, accounted for: the four live claims the sweep discards, and no terminal row.
        expect(groupFindingsVoidedByAccept(five).map((row) => row.id)).toEqual(['f-unconf', 'f-conf', 'f-appr', 'f-disp']);
        expect(summaryAcceptLeftovers(five)).toEqual({ findings: 4, tasks: 0, blocked: 0 });

        // THE REVIEW BAND IS A DIFFERENT QUESTION, and the two numbers sit on the same card
        // (`SummaryOverviewPane.tsx` prints `review.open_findings` / `review.blocking_findings` as
        // "N open findings · M critical/major"): that set is three states wide and never counts the dispute.
        expect(five.phrase!.findings.filter(isOpenPhraseFinding)).toHaveLength(3);
        expect([five.phrase!.review.open_findings, five.phrase!.review.blocking_findings]).toEqual([3, 2]);

        const gate = lockCheck(signOffFrame(five));

        // None of these rows is a wait (D-78 / L-36), `disputed` least of all — it is archived out of every
        // active list on the rail (U5) — so the control stays live and the fact lands in the line.
        expect(gate.canLock).toBe(true);
        expect(gate.reasons).toEqual([]);
        expect(gate.statement).toBe(
            'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
                ', voids 4 open findings on the Summary phrase, and starts Phrase 2 from the compiled Summary (D-72).'
        );
        // THE TOO-LOW NUMBER THE OLD CODE PRINTED, and the every-row-in-the-read number it could never print:
        // the clause names what the click discards, which is neither of those.
        expect(gate.statement).not.toContain('voids 3 open findings');
        expect(gate.statement).not.toContain('voids 6 open findings');

        // THE REAL FRAME'S SHAPE: a book whose ONLY leftover is a `disputed` claim. The sweep discards it
        // (`lock-accept.test.ts`'s `finding_3`), so the line must carry a clause at all — the old copy printed
        // the bare lock sentence and the receipt answered 1.
        const onlyDisputed = grouped({ findings: [finding({ id: 'f-disp', state: 'disputed', targeted: ['grp-tone'] })] });

        expect(summaryAcceptLeftovers(onlyDisputed)).toEqual({ findings: 1, tasks: 0, blocked: 0 });
        expect(lockCheck(signOffFrame(onlyDisputed)).statement).toContain('voids 1 open finding on the Summary phrase');
    });

    it('does not count a claim whose scope reaches past the Summary into Phrase ② (R3, D-78)', () => {
        // THE OTHER DIRECTION OF THE SAME LIE. The projection admits any row whose RESOLVED scope touches at
        // least one of this phrase's entries (`projections.ts:phraseProjection`), so a claim naming a Summary
        // group AND a Phrase ② chapter entry rides in this read — but `invalidation.ts:acceptSummaryLeftovers`
        // takes `scope.refs.every(id => summaryGroupIds.has(id))` and leaves the mixed row open on purpose
        // (`lock-accept.test.ts`'s `finding_7`: its Phrase ② half is the text the next phrase is about to
        // write). Counting it would promise a void this click does not perform.
        const mixedIds = ['grp-ending', 'grp-chapter_1'];
        const mixed = grouped({
            findings: [finding({ id: 'f-mixed', state: 'confirmed', cost: 'major', group_refs: mixedIds, targeted: mixedIds })]
        });

        // The read DOES carry the row — so the exclusion below is a scope decision, not a missing row.
        expect(phraseFindings(mixed).map((row) => row.id)).toEqual(['f-mixed']);
        expect(groupFindingsVoidedByAccept(mixed)).toEqual([]);
        expect(summaryAcceptLeftovers(mixed)).toEqual({ findings: 0, tasks: 0, blocked: 0 });

        // And the clause goes with it: the sentence states only the acts that really happen.
        expect(lockCheck(signOffFrame(mixed)).statement).toBe(
            'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
                ', and starts Phrase 2 from the compiled Summary (D-72).'
        );
    });

    it('counts a task that belongs to no Summary group at all, and never claims a scope the rows lack (R-T2/F3)', () => {
        // THE SERVER FACT this pins: `projections.ts:phraseProjection`'s `openTasks` builds the phrase read's
        // task rows as `store.tasks.list().filter(t => t.story_id === story.id &&
        // OPEN_TASK_STATES.includes(t.state))` — every unfinished task of the Story, whatever phrase or kind —
        // and `PhraseTaskRow` carries no group AND no phrase id, so the desk cannot say "on this Summary" or
        // "anywhere in the Story" from these rows. A chapter-repair task is therefore counted, and the copy
        // calls it what the read shows: a task in the queue.
        const chapterRepair = grouped({
            tasks: [task({ id: 't-chapter', title: 'Repair the chapter point-of-view slip' })],
            review: { ...groupedPhraseView('s1').review, open_tasks: 1 }
        });

        expect(groupSignOffBlockers(chapterRepair)).toEqual([]);

        // And the same frame reaches the Author's one click: enabled, with the task named in the line the
        // control prints under itself rather than in the blocker list.
        const gate = lockCheck(signOffFrame(chapterRepair));

        expect(gate.canLock).toBe(true);
        expect(gate.reasons).toEqual([]);
        expect(gate.statement).toBe(
            'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
                ', closes 1 open task in the queue as wontfix, and starts Phrase 2 from the compiled Summary (D-72).'
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
        // The screenshot's book, in the gate's own words. What it used to say — "2 open findings … await your
        // decision (D-34)" and "2 Story tasks still open in the queue" — is not a wait any more: the accept
        // voids the findings and closes the tasks (T12's server leg), so those two rows left the blocker list
        // and became the counts in the statement below. What stays is what a click could corrupt or the server
        // really refuses on: the unwritten group (R1), the missing clean selection (R2), and the Writer holding
        // Theme (R4).
        expect(groupSignOffBlockers(midReview())).toEqual([
            '1 Summary group still unwritten (Ending) — an unwritten group is not part of the Overview yet (R1)',
            'no clean Summary to accept yet — Premise: has open issues; Promise: has open issues; Theme: has open issues; Tone: has open issues',
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
        expect(gate.reasons).toHaveLength(3);
        // AC6 — the leftovers the two removed blockers used to name are here instead, counted off the same
        // rows: this book's three OPEN findings (the two blocking rows plus the `approved` minor note, which
        // the click voids even though it never held the sign-off) and its two unfinished tasks (`claimed`,
        // `open`), with the Phrase 2 promise the control's label makes.
        expect(gate.statement).toBe(
            'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
                ', voids 3 open findings on the Summary phrase, closes 2 open tasks in the queue as wontfix,' +
                ' and starts Phrase 2 from the compiled Summary (D-72).'
        );

        const clean = lockCheck(signOffFrame(grouped()));

        expect(clean.canLock).toBe(true);
        expect(clean.reasons).toEqual([]);
        // Nothing open on the book, so neither leftover clause is printed: the line states only the acts that
        // really happen, and never an empty "voids 0 findings".
        expect(clean.statement).toBe(
            'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
                ', and starts Phrase 2 from the compiled Summary (D-72).'
        );
    });

    // -----------------------------------------------------------------------
    // T13 / R2 — the ACCEPT'S OWN BAR: a clean Summary exists, or it does not.
    //
    // These are the cases the reported greyed button turned on, and they are pinned on the three states the
    // wire actually sends (`projections.ts:reviewedSummaryView`: `ready` = a complete clean selection,
    // `chosen` = the Author took one, `pending` = neither). Pinning the gate on the STATE rather than on a
    // re-derived selection is deliberate: the choose route and this control then answer from one fact.
    // -----------------------------------------------------------------------
    describe('the clean Summary the Accept control hangs on (R2)', () => {
        /** One of the reviewed frames, in the Sign-off frame (Goal passing, Ideas empty, phase ①). */
        function reviewedFrame(state: 'pending' | 'ready' | 'chosen' | 'stale' | 'writer_busy'): StoryViewData {
            return signOffFrame(fixtureView({ phrase: reviewedPhraseView('s1', state) }));
        }

        it('opens on a complete clean selection, with the open findings and open tasks on top of it (AC1)', () => {
            // THE USER'S SCENARIO, exactly: the reviewed strip is complete and the desk still greyed the button
            // over two findings and two tasks. The five-group reviewed book, plus the mid-review book's rows.
            const busy = reviewedFrame('ready');
            const withLeftovers: StoryViewData = {
                ...busy,
                phrase: {
                    ...busy.phrase!,
                    findings: [
                        finding({ id: 'f-crit', targeted: ['grp-promise'] }),
                        finding({ id: 'f-wide', cost: 'major', state: 'approved', unscoped: true, group_refs: [], targeted: [] })
                    ],
                    tasks: [task({ id: 't-1', state: 'claimed' }), task({ id: 't-2', state: 'open' })]
                }
            };

            expect(cleanSummaryExists(withLeftovers)).toBe(true);
            expect(cleanSummaryGateReason(withLeftovers)).toBe('');
            expect(groupSignOffBlockers(withLeftovers)).toEqual([]);

            const gate = lockCheck(withLeftovers);

            expect(gate.canLock).toBe(true);
            expect(gate.reasons).toEqual([]);
            expect(summaryAcceptLeftovers(withLeftovers)).toEqual({ findings: 2, tasks: 2, blocked: 0 });
        });

        it('opens on the Summary the Author chose, and on a chosen one the crew has reviewed past (D-68)', () => {
            // `chosen` is the Author's own act: the installed rows carry no Clean stamp, so the live selection
            // is EMPTY and a bar that demanded `complete` would grey the button on the one book the Author has
            // explicitly taken. `stale` is a `ready` selection beside an older choice, and it opens too.
            expect(cleanSummaryExists(reviewedFrame('chosen'))).toBe(true);
            expect(lockCheck(reviewedFrame('chosen')).canLock).toBe(true);
            expect(cleanSummaryExists(reviewedFrame('stale'))).toBe(true);
            expect(lockCheck(reviewedFrame('stale')).canLock).toBe(true);
        });

        it('refuses with ONE honest reason naming the gap, and no findings or tasks list beside it (AC3)', () => {
            // The `pending` fixture's three missing groups each fail for a DIFFERENT wire reason, and the live
            // rows say all five are written — so the gate emits one sentence, in composition order, with the
            // server's own words for each gap.
            const waiting = reviewedFrame('pending');

            expect(cleanSummaryExists(waiting)).toBe(false);
            expect(groupSignOffBlockers(waiting)).toEqual([
                'no clean Summary to accept yet — Promise: has open issues; Theme: nothing written yet; Tone: awaiting a clean pass'
            ]);

            const gate = lockCheck(waiting);

            expect(gate.canLock).toBe(false);
            // The two blockers R2 removed left the list entirely — this book DOES carry an open blocking issue
            // and it would once have had a bullet of its own beside the gap sentence.
            expect(gate.reasons).toHaveLength(1);
            expect(gate.reasons[0]).not.toContain('open finding');
            expect(gate.reasons[0]).not.toContain('Story task');
            // The phrase read DOES carry a finding here, so it is counted in the statement the Author reads
            // before the selection ever arrives — the fact is kept, the wait is gone.
            expect(gate.statement).toContain('voids 1 open finding on the Summary phrase');
        });

        it('names the state rather than inventing a reason when `pending` arrives with no gap rows', () => {
            // A payload older than D-67, or a book with no catalog rows: the wire says `pending`, and the desk
            // may not put words in it.
            const bare = reviewedFrame('pending');
            const noRows: StoryViewData = {
                ...bare,
                phrase: { ...bare.phrase!, reviewed: { ...bare.phrase!.reviewed, groups: [] } }
            };

            expect(cleanSummaryGateReason(noRows)).toBe(
                'no clean Summary to accept yet — the reviewed selection has not been reported by the phrase read'
            );
        });

        it('is not a clean Summary before the phrase read lands, whatever the state would have been', () => {
            // R-T2/F1, restated for the new bar: `phraseReviewed` answers the EMPTY block for a read that has
            // not arrived, and that block is `pending` — so the clean bar and the gate's read clause cannot
            // disagree about which of the two sentences the Author gets.
            const inFlight = signOffFrame({ ...midReview(), phrase: undefined });

            expect(cleanSummaryExists(inFlight)).toBe(false);
            expect(cleanSummaryGateReason(inFlight)).toBe(
                'no clean Summary to accept yet — the reviewed selection has not been reported by the phrase read'
            );
            // …and the gate still prints the READ sentence, not the gap sentence, because the read is the
            // first clause and returns on its own.
            expect(groupSignOffBlockers(inFlight)).toEqual([
                'the Summary group rows have not been read yet — the sign-off waits for the phrase read to answer'
            ]);
        });

        it('still refuses when the Goal has not passed, however clean the selection is (U-16)', () => {
            // AC4 — the Goal is the clause the lock route really refuses on, and R2 removed nothing here. The
            // book below is the cleanest one the desk can show: complete selection, nothing unwritten, no
            // Writer, and the Goal still answering two criteria.
            const clean = reviewedFrame('ready');
            // The fixture's two real failing criteria (`fixtureGoal`), restored over the sign-off frame's
            // emptied one — the point being that a CLEAN selection and a failing Goal co-exist, and the Goal
            // outranks it.
            const goal = fixtureGoal();
            const failing: StoryViewData = {
                ...clean,
                goal: { ...clean.goal, failing: goal.failing, phase_progress: goal.phase_progress }
            };

            expect(cleanSummaryExists(failing)).toBe(true);
            expect(groupSignOffBlockers(failing)).toEqual([]);

            const gate = lockCheck(failing);

            expect(gate.canLock).toBe(false);
            expect(gate.reasons).toEqual([
                'the Goal has not passed: C-8, C-11 still failing (4/7 \u00b7 failing: C-8, C-11)'
            ]);
        });

        it('still refuses while this phase\u2019s Ideas tray is not empty, and ignores another phase\u2019s (L-7a, D-36)', () => {
            // AC4, and the server fact behind it: `routes.ts:POST /stories/:id/lock` refuses with an undecided
            // Idea in the tray, so this is one blocker R2 may NOT relax — and it is phase-scoped, which the
            // chapter-phase Ideas the fixtures carry never are.
            const clean = reviewedFrame('ready');
            const [proposal] = fixtureIdeas().filter((idea) => idea.state === 'proposed');
            const tray: StoryViewData = {
                ...clean,
                ideas: [{ ...proposal, id: 'i-here', phase: 'summary' as const }]
            };

            expect(cleanSummaryExists(tray)).toBe(true);
            expect(groupSignOffBlockers(tray)).toEqual([]);

            const gate = lockCheck(tray);

            expect(gate.canLock).toBe(false);
            expect(gate.reasons).toEqual([
                '1 Idea still in the tray — each must be selected, discarded, or deferred first (L-7a)'
            ]);

            // The same book with the tray DECIDED opens, and the fixture's `chapters`-phase Ideas never held it.
            expect(lockCheck({ ...tray, ideas: clean.ideas }).canLock).toBe(true);
        });
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
        // AC6's other half: the leftover clauses and the Phrase 2 promise are the GROUPED accept's server acts
        // (T12), so the sampler's Summary keeps the sentence it has always printed. A grouped-only promise
        // spelled onto this book would be the desk inventing a consequence the route does not have.
        expect(lockCheck(sampling).statement).toBe(
            'Locking the Summary makes it read-only for every agent (P5, L-30) and deletes this phase\u2019s Ideas tray in the same commit (D-36).'
        );
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
