// R6 / U1-U3 + U6 — the content column's routing between the TWO Summary surfaces.
//
// `StoryView.test.tsx` pins the phrase redesign's routing for a sampling book. This file pins the other
// half: which surface a GROUP-managed book gets, and what the group selection does to the rest of the
// column. The distinction is the acceptance criterion — a grouped book must not be shown the sampler's
// round (its numbers were never produced), and a sampling book must not be shown five groups it does not
// have. Neither pane carries a branch for the other; `StoryView` chooses, on `story.summary_mode`.
//
// T13 adds the second block: the Accept control on a grouped book. `story-contract` and `story-nav` pin the
// gate and the rail's agreement; this file pins the two halves only a render can prove — the button is
// actually live over the findings and tasks the accept clears, and the sentence printed under it tells the
// Author what the click does with them (and with Phrase 2) before it is pressed.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { StoryView } from './StoryView';
import { fixtureActions, fixtureIdeas, fixturePhrase, fixtureView } from './story-fixtures';
import { groupedPhraseView, reviewedPhraseView } from '../testing/shell-fakes';
import { NOW } from './story-fixtures';
import type { PhraseView } from '../api';
import type { StoryViewData } from './story-contract';

/**
 * A grouped book in phase ①, Goal passing, Ideas tray empty: the frame in which the phase gate is allowed
 * to render, so a test can tell "the gate is gone" from "the gate had no reason to be there".
 */
function groupedView(phrase: PhraseView = fixturePhrase()) {
    const view = fixtureView({ phrase });

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

/** The same book before the phrase read lands: the Story row says `groups`, the rows have not arrived. */
function pendingGroupedView() {
    const view = groupedView();

    return { ...view, phrase: undefined };
}

/** A sampling book in phase ① — the surface this workspace shipped, which the redesign leaves alone. */
function samplingView() {
    const view = fixtureView();

    return {
        ...view,
        story: {
            ...view.story,
            phase: 'summary' as const,
            summary_locked: false,
            status: 'ready' as const,
            pending_kind: 'none' as const,
            status_reason: undefined
        }
    };
}

function renderView(props: Partial<Parameters<typeof StoryView>[0]> = {}, view: StoryViewData = groupedView()) {
    const harness = fixtureActions();

    return {
        ...harness,
        ...render(<StoryView view={view} actions={harness.actions} now={NOW} {...props} />)
    };
}

describe('StoryView — a group-managed book gets the grouped Overview, not the round (U1, U3)', () => {
    it('renders the Overview pane and none of the sampler’s ledger', () => {
        const { container } = renderView();

        expect(screen.getByTestId('summary-overview')).toBeTruthy();
        expect(container.querySelectorAll('.sv-group-row')).toHaveLength(5);
        // The sampling surface is absent in both shapes it takes: the revision ledger and the dials.
        expect(container.querySelector('.sv-summary-revisions')).toBeNull();
        expect(container.querySelector('.sv-summary-dials')).toBeNull();
        expect(container.querySelectorAll('input[type="number"]')).toHaveLength(0);
        // …and the verb the sampler needed is gone from the gate under it (U3).
        expect(screen.queryByRole('button', { name: 'Request another revision round' })).toBeNull();
    });

    it('hands the Overview the action object, so the Author\'s choose is a live verb (D-68)', () => {
        // The pane's Choose button is enabled only when `actions.chooseReviewedSummary` exists — so this is
        // the one place that can tell "the shell bound the verb" from "the pane rendered a dead button".
        // `reviewedPhraseView(…, 'ready')`, not the mid-review fixture: the fixture's reviewed block is
        // `pending`, and a pending book offers no Choose at all (D-67).
        const { calls, container } = renderView({}, groupedView(reviewedPhraseView('s1', 'ready')));
        const submit = container.querySelector('[data-testid="reviewed-choose-submit"]') as HTMLButtonElement;

        expect(submit.disabled).toBe(false);

        // Clicking arms the confirmation step first; only the confirm reaches the verb (D-68).
        fireEvent.click(submit);
        fireEvent.click(screen.getByTestId('reviewed-choose-confirm'));

        expect(calls.chooseReviewedSummary).toEqual([['s1']]);
    });

    it('leaves the choose bound to nothing when the shell hands down no actions, and the pane says so', () => {
        const { container } = render(
            <StoryView view={groupedView(reviewedPhraseView('s1', 'ready'))} actions={undefined} now={NOW} />
        );
        const submit = container.querySelector('[data-testid="reviewed-choose-submit"]') as HTMLButtonElement;

        expect(submit.disabled).toBe(true);
        expect(submit.getAttribute('title')).toBe('The reviewed-Summary choose route is not available in this shell.');
    });

    it('keeps the phase gate on the Overview only, and only once (U5)', () => {
        const { container } = renderView();

        expect(container.querySelectorAll('.sv-phase-controls')).toHaveLength(1);
        // The gate is the Author's sign-off, so its reasons are on screen where the Overview is.
        expect(container.querySelector('.sv-lock-block')).toBeTruthy();
        expect(container.textContent).toContain('1 Summary group still unwritten (Ending)');
        // The grouped blockers reached the gate rather than the gate inventing the sampler's ones.
        expect(container.textContent).toContain('the Writer is rewriting Theme right now');
        expect(container.textContent).not.toContain('still in this round');
    });

    it('shows its own loading line while the phrase read is in flight, with no groups invented (U6)', () => {
        const { container } = renderView({}, pendingGroupedView());

        expect(screen.getByTestId('summary-overview-pending')).toBeTruthy();
        expect(container.querySelector('.sv-group-rows')).toBeNull();
        expect(container.querySelector('.sv-summary-revisions')).toBeNull();
    });

    it('leaves a sampling book on the round, with its verbs intact (U1)', () => {
        const { container } = renderView({}, samplingView());

        expect(screen.queryByTestId('summary-overview')).toBeNull();
        expect(container.querySelector('.sv-summary-revisions')).toBeTruthy();
        // The one verb the sampler's round still needs is still there for the book that runs the sampler.
        expect(screen.getByRole('button', { name: 'Request another revision round' })).toBeTruthy();
        expect(container.textContent).not.toContain('Summary group still unwritten');
    });

    it('prints the sampler’s round number for a sampling book, and never for a grouped one (U3)', () => {
        const sampling = {
            ...samplingView(),
            sampling: { round: 3, active_round: 4, history: [] }
        };
        const { container: samplingPane } = renderView({}, sampling);

        expect(samplingPane.querySelector('.sv-story-sampling')?.textContent).toBe('Sampling round 3');

        const grouped = { ...groupedView(), sampling: { round: 3, active_round: 4, history: [] } };
        const { container: groupedPane } = renderView({}, grouped);

        // The loop writes five groups; a round number over its Overview would be a number the engine
        // never produced.
        expect(groupedPane.querySelector('.sv-story-sampling')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// T13 / R2 — THE ACCEPT'S BAR, on the surface the Author presses.
//
// `story-contract.groups.test.ts` pins the rule and `story-nav.groups.test.ts` pins the rail's agreement; this
// block pins the two things only a render can prove: the control is actually enabled over the leftovers the
// accept clears, and the sentence under it names them BEFORE the click. The reported state was a greyed button
// with two bullets about findings and tasks that the accept itself voids and closes.
// ---------------------------------------------------------------------------
describe('StoryView — the Accept control opens on a clean Summary and stays shut on the real waits (T13, R2)', () => {
    /** One finding row, in the shape the phrase read sends it. */
    const openFinding = (
        id: string,
        cost: 'critical' | 'major' | 'minor' = 'critical',
        state: 'unconfirmed' | 'confirmed' | 'approved' | 'disputed' | 'fixed' | 'discarded' = 'confirmed'
    ) => ({
        id,
        title: 'the Ending contradicts the promise it opens on',
        cost,
        kind: 'issue' as const,
        state,
        seen_count: 1,
        group_refs: ['grp-tone'],
        unscoped: false,
        targeted: ['grp-tone'],
        resolved: [],
        missing: ['grp-tone'],
        resolved_all: false
    });

    /** One queue row. `wontfix` is settled work, and the copy must not promise to close it twice. */
    const openTask = (id: string, state: 'open' | 'claimed' | 'blocked' | 'done' | 'wontfix' = 'open') => ({
        id,
        title: 'close out the tone the premise implies',
        state,
        owner_role: 'writer',
        attempts: 0,
        finding_ref: null
    });

    /** A reviewed state, with the leftovers the accept clears written over the read's own rows. */
    function reviewedWith(
        state: 'pending' | 'ready' | 'chosen' | 'stale' | 'writer_busy',
        findings: ReturnType<typeof openFinding>[] = [],
        tasks: ReturnType<typeof openTask>[] = []
    ) {
        const view = groupedView(reviewedPhraseView('s1', state));

        return { ...view, phrase: { ...view.phrase!, findings, tasks } };
    }

    /** The two sentences the gate may print under the control, spelled once so a reword names the case. */
    const CLEAN_STATEMENT =
        'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
        ', and starts Phrase 2 from the compiled Summary (D-72).';

    it('is live over open findings and open tasks, and says what the click does with them (AC1, AC6)', async () => {
        const view = reviewedWith(
            'ready',
            [openFinding('f-crit'), openFinding('f-major', 'major')],
            [openTask('t-open'), openTask('t-claimed', 'claimed'), openTask('t-wontfix', 'wontfix')]
        );
        const harness = fixtureActions();

        const { container } = render(
            <StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'summary' }} />
        );

        const lock = container.querySelector('.sv-lock-button') as HTMLButtonElement;

        expect(lock.disabled).toBe(false);
        // Nothing blocks, so the reason list is not rendered at all — an empty `<ul>` would read as a wait.
        expect(document.querySelector('.sv-lock-reasons')).toBeNull();
        // AC6 — the leftovers are counted where the Author reads them, from the rows the gate already read: two
        // blocking findings, and TWO tasks (the `wontfix` row is settled, so it is not offered as work the
        // accept still closes).
        expect((document.querySelector('.sv-lock-statement') as HTMLElement).textContent).toBe(
            'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
                ', voids 2 open findings on the Summary phrase, closes 2 open tasks in the queue as wontfix,' +
                ' and starts Phrase 2 from the compiled Summary (D-72).'
        );
        expect(lock.getAttribute('title')).toBe(
            (document.querySelector('.sv-lock-statement') as HTMLElement).textContent
        );
        // The label is the promise the sentence spells out, and it is still the grouped book's verb.
        expect(lock.textContent).toBe('Accept final Summary → Phrase 2');

        // And the press is the one verb the desk bound: the lock route, no argument, phase from the record
        // (§6.3a) — behind the ask-once confirm (L-32), which prints the SAME sentence it just showed.
        fireEvent.click(lock);

        expect((container.querySelector('.sv-confirm-text') as HTMLElement).textContent).toBe(
            (document.querySelector('.sv-lock-statement') as HTMLElement).textContent
        );
        expect(harness.calls.lockPhase).toBeUndefined();

        fireEvent.click(container.querySelector('.sv-confirm-yes') as HTMLButtonElement);

        expect(harness.calls.lockPhase).toEqual([['s1']]);
    });

    it('names what the click closes and what it leaves, so the line cannot overstate (U-16)', () => {
        // THE MISMATCH, on the surface the Author reads. The accept's commit sweeps `open` + `claimed` and
        // reports that number as `lock_receipt.wontfixed_tasks`; `blocked` is the crew's question to the
        // Author, so the sweep skips it. The line used to count the whole queue and promise to close all of it,
        // so a book with a blocked row read "closes 3 open tasks" over a receipt saying 2. `done` and
        // `wontfix` are settled and belong to neither clause. THE GATE IS UNTOUCHED: none of these rows is a
        // blocker (D-78), which is what `lock.disabled` pins here on a book carrying all five states.
        const view = reviewedWith(
            'ready',
            [openFinding('f-issue')],
            [
                openTask('t-open'),
                openTask('t-claimed', 'claimed'),
                openTask('t-blocked', 'blocked'),
                openTask('t-done', 'done'),
                openTask('t-wontfix', 'wontfix')
            ]
        );
        const harness = fixtureActions();

        const { container } = render(
            <StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'summary' }} />
        );

        const lock = container.querySelector('.sv-lock-button') as HTMLButtonElement;

        expect(lock.disabled).toBe(false);
        expect(container.querySelector('.sv-lock-reasons')).toBeNull();
        // Every clause, spelled once: 2 swept, 1 left, and the two settled rows named by neither.
        expect((container.querySelector('.sv-lock-statement') as HTMLElement).textContent).toBe(
            'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
                ', voids 1 open finding on the Summary phrase, closes 2 open tasks in the queue as wontfix,' +
                ' leaves 1 blocked task for you, and starts Phrase 2 from the compiled Summary (D-72).'
        );
        // THE OVERSTATEMENT IS GONE by construction: the queue is 3 open rows wide and the read carries 5, and
        // the "closes" clause may not borrow either number.
        expect((container.querySelector('.sv-lock-statement') as HTMLElement).textContent).not.toContain(
            'closes 3 open tasks'
        );
        expect((container.querySelector('.sv-lock-statement') as HTMLElement).textContent).not.toContain(
            'closes 5 open tasks'
        );
        // The confirm repeats the SAME line, so the number cannot drift between the desk and the ask.
        fireEvent.click(lock);

        expect((container.querySelector('.sv-confirm-text') as HTMLElement).textContent).toBe(
            (container.querySelector('.sv-lock-statement') as HTMLElement).textContent
        );

        fireEvent.click(container.querySelector('.sv-confirm-yes') as HTMLButtonElement);

        expect(harness.calls.lockPhase).toEqual([['s1']]);
    });

    it('counts the `disputed` row the accept discards, which the review band never counted (D-78, D-33c)', () => {
        // THE DEFECT, on the surface the Author reads. The clause under the control used to carry the Overview's
        // REVIEW band (`OPEN_PHRASE_FINDING_STATES` — `unconfirmed`/`confirmed`/`approved`, the wire's
        // `review.open_findings`), while the act it describes is `phrase/locks.ts:voidFindingsOnLock` over
        // `VOIDABLE_FINDING_STATES`, which discards `disputed` as well: D-33c reads a dispute as a live claim
        // about text that has just stopped being writable. Verified live — a book the desk booked as 3 while
        // `lock_receipt.voided_findings` answered 4. `fixed` and `discarded` are terminal in §4.10 and belong to
        // neither number, and the cost bar is a third number again (the `minor` note below is voided, not blocking).
        const view = reviewedWith('ready', [
            openFinding('f-unconf', 'major', 'unconfirmed'),
            openFinding('f-conf'),
            openFinding('f-appr', 'minor', 'approved'),
            openFinding('f-disp', 'major', 'disputed'),
            openFinding('f-fixed', 'critical', 'fixed'),
            openFinding('f-disc', 'critical', 'discarded')
        ]);

        render(<StoryView view={view} actions={fixtureActions().actions} now={NOW} selection={{ panel: 'summary' }} />);

        const statement = (document.querySelector('.sv-lock-statement') as HTMLElement).textContent;
        const lock = document.querySelector('.sv-lock-button') as HTMLButtonElement;

        // None of these rows is a wait (D-78 / L-36) — a `disputed` row least of all, since the rail files it as
        // archived (U5) — so the control is live and the count is the line's.
        expect(lock.disabled).toBe(false);
        expect(statement).toBe(
            'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
                ', voids 4 open findings on the Summary phrase, and starts Phrase 2 from the compiled Summary (D-72).'
        );
        // THE NUMBER THE OLD COPY PRINTED (the three-state band), and the every-row-in-the-read number it never
        // could: the clause books what the click discards, which is neither.
        expect(statement).not.toContain('voids 3 open findings');
        expect(statement).not.toContain('voids 6 open findings');
    });

    it('is live on the Summary the Author chose, and on the one reviewed past it (D-68)', () => {
        for (const state of ['chosen', 'stale'] as const) {
            const { container } = render(<StoryView view={reviewedWith(state)} actions={fixtureActions().actions} now={NOW} />);
            const lock = container.querySelector('.sv-lock-button') as HTMLButtonElement;

            expect(lock.disabled, state).toBe(false);
            expect(container.querySelector('.sv-lock-reasons'), state).toBeNull();
            // No leftovers on these books, so the line states only the acts that really happen.
            expect((container.querySelector('.sv-lock-statement') as HTMLElement).textContent, state).toBe(
                CLEAN_STATEMENT
            );
        }
    });

    it('is greyed with ONE reason naming the gap when there is no clean Summary to accept (AC3)', () => {
        // The screenshot's shape, inverted: the control is shut, but the bullet is the selection's own gap —
        // not the open finding the read also carries, and not the queue.
        const view = reviewedWith('pending', [openFinding('f-issue', 'major')], [openTask('t-open')]);

        render(<StoryView view={view} actions={fixtureActions().actions} now={NOW} selection={{ panel: 'summary' }} />);

        const lock = screen.getByRole('button', { name: 'Accept final Summary → Phrase 2' }) as HTMLButtonElement;

        expect(lock.disabled).toBe(true);
        expect(Array.from(document.querySelectorAll('.sv-lock-reasons li')).map((line) => line.textContent)).toEqual([
            'no clean Summary to accept yet — Promise: has open issues; Theme: nothing written yet; Tone: awaiting a clean pass'
        ]);
        expect(lock.getAttribute('title')).toBe(
            'Not yet: no clean Summary to accept yet — Promise: has open issues; Theme: nothing written yet; Tone: awaiting a clean pass'
        );
        // The finding the read carries is still counted, in the line rather than in the blocker list.
        expect((document.querySelector('.sv-lock-statement') as HTMLElement).textContent).toContain(
            'voids 1 open finding on the Summary phrase, closes 1 open task in the queue as wontfix'
        );
    });

    it('is greyed while a Writer holds a group, however clean the selection is (R4)', () => {
        // The one blocker R2 may not relax on a clean book: a Writer installing text after the accept would
        // write over a read-only Summary (P5).
        const { container } = render(
            <StoryView view={reviewedWith('writer_busy')} actions={fixtureActions().actions} now={NOW} />
        );
        const lock = container.querySelector('.sv-lock-button') as HTMLButtonElement;

        expect(lock.disabled).toBe(true);
        expect(Array.from(container.querySelectorAll('.sv-lock-reasons li')).map((line) => line.textContent)).toEqual([
            'the Writer is rewriting Ending right now — the text on screen is about to move (R4)'
        ]);
    });

    it('is greyed while the Ideas tray holds an undecided Idea, over a complete selection (L-7a)', () => {
        // The server really refuses here (`routes.ts:POST /stories/:id/lock`), and the tray is PHASE-scoped —
        // the fixtures' `chapters`-phase Ideas never hold the Summary's gate, so this frame states the case that
        // does, and proves R2 did not relax the one wait the route enforces.
        const clean = reviewedWith('ready');
        const [proposal] = fixtureIdeas().filter((idea) => idea.state === 'proposed');

        const { container } = render(
            <StoryView
                view={{ ...clean, ideas: [{ ...proposal, id: 'i-here', phase: 'summary' as const }] }}
                actions={fixtureActions().actions}
                now={NOW}
            />
        );
        const lock = container.querySelector('.sv-lock-button') as HTMLButtonElement;

        expect(lock.disabled).toBe(true);
        expect(Array.from(container.querySelectorAll('.sv-lock-reasons li')).map((line) => line.textContent)).toEqual([
            '1 Idea still in the tray — each must be selected, discarded, or deferred first (L-7a)'
        ]);
    });
});

describe('StoryView — the rail’s group ref opens that group and closes the Overview (U2)', () => {
    it('renders one group pane, addressed by the ref’s uuid', () => {
        const { container } = renderView({ selection: { panel: 'summary', ref: 'summary-group:grp-promise' } });

        expect(screen.getByTestId('group-pane-promise')).toBeTruthy();
        expect(screen.getByTestId('group-title').textContent).toBe('Promise');
        expect(screen.queryByTestId('summary-overview')).toBeNull();
        // The gate belongs to the Summary as a whole, so a group's pane does not carry it.
        expect(container.querySelector('.sv-phase-controls')).toBeNull();
        // …and no other phrase or folder crept in with it.
        expect(container.querySelector('.sv-ideas')).toBeNull();
        expect(container.querySelector('.sv-chapters')).toBeNull();
        expect(container.querySelector('.sv-summary-revisions')).toBeNull();
    });

    it('follows the uuid across a refetch that delivers the rows in another order (U2)', () => {
        const reversed = groupedView({ ...fixturePhrase(), groups: [...fixturePhrase().groups].reverse() });
        const { rerender, ...first } = renderView(
            { selection: { panel: 'summary', ref: 'summary-group:grp-tone' } },
            reversed
        );

        expect(screen.getByTestId('group-pane-tone')).toBeTruthy();
        expect(screen.getByTestId('group-title').textContent).toBe('Tone');

        // A second read of the same rows, and the pane has not moved.
        rerender(
            <StoryView
                view={groupedView({ ...fixturePhrase(), groups: [...fixturePhrase().groups].reverse() })}
                actions={first.actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'summary-group:grp-tone' }}
            />
        );
        expect(screen.getByTestId('group-title').textContent).toBe('Tone');
    });

    it('falls back to the Overview when the ref names a group this book does not have (U6)', () => {
        // The selection is what the rail was holding; the read says the group is gone (a re-import, or the
        // book switched back to `sampling`). The Author lands on the Overview, not on an empty pane.
        const { container } = renderView({ selection: { panel: 'summary', ref: 'summary-group:grp-retired' } });

        expect(screen.getByTestId('summary-overview')).toBeTruthy();
        expect(screen.queryByTestId('group-pane-stale')).toBeNull();
        expect(container.querySelector('.sv-group-row')).toBeTruthy();
    });

    it('falls back on a story switch, in the same frame the new book arrives (U6)', () => {
        const first = groupedView();
        const { rerender, ...harness } = renderView({ selection: { panel: 'summary', ref: 'summary-group:grp-tone' } }, first);

        expect(screen.getByTestId('group-pane-tone')).toBeTruthy();

        // The new book's groups carry different ids — as two real books' always do.
        const otherBook: PhraseView = {
            ...groupedPhraseView('s2'),
            groups: groupedPhraseView('s2').groups.map((group) => ({ ...group, id: `${group.key}-of-s2` }))
        };

        rerender(
            <StoryView
                view={groupedView(otherBook)}
                actions={harness.actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'summary-group:grp-tone' }}
            />
        );

        expect(screen.getByTestId('summary-overview')).toBeTruthy();
        expect(screen.queryByTestId('group-pane-tone')).toBeNull();
    });

    it('holds the selection while the rows have not arrived, and shows one honest loading line (U6)', () => {
        // Before the read lands the dashboard cannot tell a deleted group from an unseen one, so the rail
        // keeps its selection (`story-nav.ts:selectionExists`) and the column resolves the ref to nothing.
        // The Overview's loading line is the single sentence that is true in both readings; the group pane's
        // own pending state is the same sentence for a pane handed an unresolved read directly.
        const { container } = renderView(
            { selection: { panel: 'summary', ref: 'summary-group:grp-promise' } },
            pendingGroupedView()
        );

        expect(screen.getByTestId('summary-overview-pending')).toBeTruthy();
        expect(container.querySelector('.sv-group-rows')).toBeNull();
        expect(screen.queryByTestId('group-pane-promise')).toBeNull();
        expect(screen.queryByTestId('group-pane-stale')).toBeNull();
    });

    it('sends the same selection object a rail click would, so the two cannot drift (U2)', () => {
        const onSelect = vi.fn();

        renderView({ onSelect });

        const themeRow = document.querySelector('[data-testid="summary-group-theme"] button') as HTMLButtonElement;
        themeRow.click();

        expect(onSelect).toHaveBeenLastCalledWith({ panel: 'summary', ref: 'summary-group:grp-theme' });
    });
});

describe('StoryView — the folders and the Seed still route as they did (U1)', () => {
    it('routes a folder selection to its own pane, with no Summary surface beside it', () => {
        const { container } = renderView({ selection: { panel: 'ideas' } });

        expect(container.querySelector('.sv-ideas')).toBeTruthy();
        expect(screen.queryByTestId('summary-overview')).toBeNull();
        expect(container.querySelector('.sv-summary-revisions')).toBeNull();
    });

    it('routes the Seed to its own pane, grouped book or not', () => {
        const { container } = renderView({ selection: { panel: 'seed' } });

        expect(screen.queryByTestId('summary-overview')).toBeNull();
        expect(screen.queryByTestId('group-pane-promise')).toBeNull();
        expect(container.querySelector('.sv-group-row')).toBeNull();
    });
});
