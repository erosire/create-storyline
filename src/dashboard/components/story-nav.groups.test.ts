// R6 — the rail's model for the SUMMARY PHRASE and its five groups (U1, U2, U6, U7).
//
// This suite pins the DERIVATIONS the rail and the panes share, where a wrong answer is invisible in any
// one screenshot:
//   U1 — the rail has ONE phrase (Summary) and the folders that support it; the other three phrases stay
//        in the pane vocabulary so a later phase's selection still resolves to a real title.
//   U2 — a group's address is `summary-group:<id>` with the id used verbatim: the rail never parses the
//        shape of an id, so the server's real uuids need no client-side change.
//   U6 — a ref that names no live group falls back, and a ref whose read has not landed does not (the two
//        states are told apart by `phraseLoaded`, which is the only honest answer available).
//   U5 — readiness, attention and the directive bar's refs all come from the group rows, not from the
//        sampler's numbers.
//
// T13 adds the AC5 set at the bottom of the readiness block: the rail's ready tick and the Accept button are
// ONE fact (`story-nav.summaryReadyForReview` delegates to `story-contract.lockCheck` for a grouped book), and
// the cases pin the agreement in both directions — including the post-lock frame, where the tick deliberately
// stays on and the gate deliberately stops naming the group's waits.
import { describe, expect, it } from 'vitest';

import {
    ALL_STORY_PHRASES,
    DEFAULT_STORY_SELECTION,
    STORY_PHRASES,
    STORY_SUPPLEMENTS,
    attentionFor,
    directiveFocus,
    // T-W4 — Phrase ②'s rail model: its ref prefix, its entry rows, and the two predicates the rail's marks
    // are painted from. Pinned by name, in this file, beside the Summary's equivalents.
    parsePlotlineGroupRef,
    parseSummaryGroupRef,
    phraseLoaded,
    plotlineGroupFocus,
    plotlineGroupRef,
    plotlineRailEntries,
    plotlinesRailSurfaceOpen,
    plotlinesReadyToStart,
    selectionExists,
    selectionTitle,
    storyAttention,
    summaryGroupEntries,
    summaryGroupFocus,
    summaryGroupRef,
    summaryReadyForReview
} from './story-nav';
import type { PlotlineRailEntry } from './story-nav';
import { groupSignOffBlockers, lockCheck } from './story-contract';
import { fixtureGoal, fixtureIdeas, fixturePhrase, fixtureView } from '../testing/story-fixtures';
import { groupedPhraseView, phraseDetailView, reviewedPhraseView } from '../testing/shell-fakes';
// T-W4 — the Phrase ② read's type is pinned by name so the fixture builder above cannot drift off the wire
// shape, and `StoryViewData` is the view every helper below is called with.
import type { PhraseDetailView, PhraseView } from '../api';
import type { StoryViewData } from './story-contract';
// T3 — the entry type is pinned by NAME here, not inferred: the key-presence assertions below pass an entry
// that may be `undefined` (a missing key must fail loudly, and `Object.keys(undefined)` would throw), so the
// helper's signature is part of the contract being checked.
import type { SummaryGroupEntry } from './story-nav';

/** The mid-review grouped book the panes' suite uses, so both suites pin the same numbers. */
function midReview() {
    return fixtureView({ phrase: fixturePhrase() });
}

/** The same book, moved into phase ① with a passing Goal and an empty Ideas tray. */
function summaryPhase(
    overrides: { locked?: boolean; failing?: boolean; phrase?: PhraseView } = {}
) {
    const view = midReview();

    return {
        ...view,
        // T13/AC5 — the agreement cases need a book whose REVIEWED state is one of the wire's three, which is
        // the one input the accept's bar reads; the rest of the frame stays the mid-review book's.
        phrase: overrides.phrase ?? view.phrase,
        story: {
            ...view.story,
            phase: 'summary' as const,
            summary_locked: overrides.locked ?? false,
            status: 'ready' as const,
            pending_kind: 'none' as const,
            status_reason: undefined
        },
        goal: {
            ...view.goal,
            // G-2 renders the failing criteria; an empty list is the loop saying the Goal has passed.
            failing: overrides.failing ? view.goal.failing.slice(0, 1) : [],
            phase_progress: '4/4'
        },
        ideas: []
    };
}

describe('story-nav — two numbered phrases in the rail, the sheet off the numbering (U1, T-W4)', () => {
    it('offers the Summary and Plotlines phrases, numbered one and two, and keeps every folder', () => {
        expect(STORY_PHRASES).toEqual([
            { key: 'summary', number: 1, title: 'Summary' },
            { key: 'plotlines', number: 2, title: 'Plotlines' }
        ]);
        // T-W4 — the numbering follows the pipeline: Summary ① → Plotlines ② → Chapters ③. Characters is NOT
        // removed from the product, only from the numbering (it is a supplementary sheet the loop never signs
        // off), and Chapters keeps its pane and its key while having no rail row of its own.
        expect(ALL_STORY_PHRASES.map((phrase) => [phrase.number, phrase.key])).toEqual([
            [1, 'summary'],
            [2, 'plotlines'],
            [3, 'chapters']
        ]);
        // The sheet the rail still offers, one row deep, with NO number to print.
        expect(STORY_SUPPLEMENTS).toEqual([{ key: 'characters', title: 'Characters' }]);
    });

    it('defaults the desk\'s selection to the Summary phrase\'s own header, not to a group', () => {
        expect(DEFAULT_STORY_SELECTION).toEqual({ panel: 'summary' });
        // A header selection is the Overview: no ref, so `summaryGroupFocus` names no group.
        const view = midReview();

        expect(summaryGroupFocus(view, DEFAULT_STORY_SELECTION)).toBeUndefined();
        expect(selectionExists(view, DEFAULT_STORY_SELECTION)).toBe(true);
        expect(selectionTitle(view, DEFAULT_STORY_SELECTION)).toBe('Phrase 1 — Summary');
    });
});

describe('story-nav — a group is addressed by its id string (U2)', () => {
    it('prefixes the ref and reads it back verbatim, so a uuid needs no parsing', () => {
        expect(summaryGroupRef('grp-promise')).toBe('summary-group:grp-promise');
        expect(parseSummaryGroupRef('summary-group:grp-promise')).toBe('grp-promise');
        // A real uuid (what the server sends, `shared/phrase`'s rows are uuid-keyed) round-trips unchanged:
        // the dashboard never inspects the shape of an id.
        const uuid = '0f9f0e2c-6a5d-4f1a-9b64-8f2f3a7c11d0';

        expect(parseSummaryGroupRef(summaryGroupRef(uuid))).toBe(uuid);
        // The legacy rail ref is NOT a group ref, so an older payload cannot be read as one.
        expect(parseSummaryGroupRef('revision:rev-7')).toBeUndefined();
        expect(parseSummaryGroupRef(undefined)).toBeUndefined();
        expect(parseSummaryGroupRef('summary-group:')).toBeUndefined();
    });

    it('lists the five groups in composition order, each with its own ref and counts', () => {
        expect(summaryGroupEntries(midReview()).map((entry) => [
            entry.group.key,
            entry.ref,
            entry.openFindings,
            entry.blockingFindings,
            entry.writerBusy,
            entry.written
        ])).toEqual([
            // Premise, Promise, Theme, Tone, Ending — the catalog's order, not the array's (the fixture
            // ships them in order, and the sort is what keeps them there after a refetch).
            ['premise', 'summary-group:grp-premise', 1, 1, false, true],
            ['promise', 'summary-group:grp-promise', 3, 2, false, true],
            ['theme', 'summary-group:grp-theme', 2, 2, true, true],
            ['tone', 'summary-group:grp-tone', 1, 1, false, true],
            ['ending', 'summary-group:grp-ending', 1, 1, false, false]
        ]);
    });

    // T3 — the rail's percentage and the pane's `(was …)` line are BOTH read out of this entry, so the two
    // surfaces cannot sort the trail or round it their own way. The values are `fixturePhrase()`'s two passes
    // per written group (78→84, 55→62, 64→58) and its single pass for Theme. The load-bearing half is the
    // ABSENCE: a group nobody scored carries no `score` KEY at all, which is what makes the rail row and the
    // pane's block print nothing instead of a `0%` that claims a review that never ran.
    it('carries each group’s latest and previous percentage, and no key at all for a group nobody scored (T3)', () => {
        expect(
            summaryGroupEntries(midReview()).map((entry) => [entry.group.key, entry.score, entry.previousScore])
        ).toEqual([
            ['premise', 84, 78],
            ['promise', 62, 55],
            ['theme', 71, undefined],
            ['tone', 58, 64],
            ['ending', undefined, undefined]
        ]);

        const byKey = (key: string) =>
            summaryGroupEntries(midReview()).find((entry) => entry.group.key === key);

        // Key SETS rather than truthiness: an `undefined`-valued key would spread into a rendered `0%` on a
        // surface that tests `entry.score !== undefined` inconsistently, and the rail's row is such a surface.
        // Listed by name, not by suffix matching — `score` and `previousScore` differ only in case, and a
        // substring test would silently miss one of them.
        const scoreKeys = (entry?: SummaryGroupEntry) =>
            Object.keys(entry ?? {}).filter((name) => name === 'score' || name === 'previousScore');

        expect(scoreKeys(byKey('ending'))).toEqual([]);
        // …and a first pass carries the number with nothing to compare it to, which is what the rail's tooltip
        // and the pane's missing delta line both say out loud.
        expect(scoreKeys(byKey('theme'))).toEqual(['score']);
        expect(scoreKeys(byKey('premise'))).toEqual(['score', 'previousScore']);
    });

    it('resolves the rail ref to the live row, and names no group for a sampling book or a header click', () => {
        const view = midReview();
        const focus = summaryGroupFocus(view, { panel: 'summary', ref: summaryGroupRef('grp-tone') });

        expect(focus?.id).toBe('grp-tone');
        expect(focus?.title).toBe('Tone');
        // A sampling book's rail has no groups, so a ref left over from a grouped book resolves to nothing.
        expect(summaryGroupFocus(fixtureView(), { panel: 'summary', ref: summaryGroupRef('grp-tone') })).toBeUndefined();
        // And a ref aimed at another panel is not the Summary's business.
        expect(summaryGroupFocus(view, { panel: 'chapters', ref: summaryGroupRef('grp-tone') })).toBeUndefined();
    });

    it('follows the id, never the row position, when the server delivers the rows in another order', () => {
        const reversed = { ...fixturePhrase(), groups: [...fixturePhrase().groups].reverse() };
        const view = fixtureView({ phrase: reversed });
        const entries = summaryGroupEntries(view);

        expect(entries.map((entry) => entry.group.key)).toEqual(['premise', 'promise', 'theme', 'tone', 'ending']);
        expect(summaryGroupFocus(view, { panel: 'summary', ref: summaryGroupRef('grp-ending') })?.title).toBe(
            'Ending'
        );
    });
});

describe('story-nav — a stale ref falls back, a loading ref does not (U6)', () => {
    it('keeps a group selected once the read has landed and the uuid is among the rows', () => {
        expect(selectionExists(midReview(), { panel: 'summary', ref: summaryGroupRef('grp-promise') })).toBe(true);
    });

    it('drops a ref whose uuid is no longer in the rows — a retired group, or a book back to sampling', () => {
        const stale = { panel: 'summary' as const, ref: summaryGroupRef('grp-retired') };

        expect(selectionExists(midReview(), stale)).toBe(false);

        // The book switched to `sampling`: the echo read has no rows at all, so the rail cannot keep
        // standing on a group it can no longer draw.
        const sampling = fixtureView({ phrase: groupedPhraseView('s1', { mode: 'sampling', groups: [] }) });

        expect(selectionExists(sampling, stale)).toBe(false);
    });

    it('holds the selection while the phrase read is still in flight, because nothing proves the group is gone', () => {
        const view = { ...midReview(), phrase: undefined };

        expect(phraseLoaded(view)).toBe(false);
        expect(selectionExists(view, { panel: 'summary', ref: summaryGroupRef('grp-promise') })).toBe(true);
        // …while the Overview's own loading line is what the pane renders, since `summaryGroupFocus` can
        // only resolve against rows that have arrived.
        expect(summaryGroupFocus(view, { panel: 'summary', ref: summaryGroupRef('grp-promise') })).toBeUndefined();
    });

    it('treats a story switch as a new set of ids: the old uuid is gone the moment the new read lands', () => {
        // The server's ids are uuids, and two books never share one. `grp-` ids stand in for them here —
        // what is being pinned is that a ref from the previous book resolves against THIS book's rows.
        const otherBook: PhraseView = {
            ...groupedPhraseView('s2'),
            groups: groupedPhraseView('s2').groups.map((group) => ({
                ...group,
                id: `${group.key}-of-s2`
            }))
        };
        const view = fixtureView({ phrase: otherBook });

        expect(selectionExists(view, { panel: 'summary', ref: summaryGroupRef('grp-promise') })).toBe(false);
        expect(selectionExists(view, { panel: 'summary', ref: summaryGroupRef('promise-of-s2') })).toBe(true);
        // The default selection (no ref) survives every switch, which is what the fallback navigates to.
        expect(selectionExists(view, DEFAULT_STORY_SELECTION)).toBe(true);
    });

    it('names an opened group by its title, and never by a revision number (U2, U7)', () => {
        const view = midReview();

        expect(selectionTitle(view, { panel: 'summary', ref: summaryGroupRef('grp-theme') })).toBe(
            'Phrase 1 — Summary · Theme'
        );
        // A ref that no longer resolves falls back to the phrase's own label rather than inventing a title.
        expect(selectionTitle(view, { panel: 'summary', ref: summaryGroupRef('grp-gone') })).toBe(
            'Phrase 1 — Summary'
        );
        // The legacy ref shape still reads, for a selection a sampling-mode book is holding.
        expect(selectionTitle(fixtureView(), { panel: 'summary', ref: 'revision:does-not-exist' })).toBe(
            'Phrase 1 — Summary'
        );
    });
});

describe('story-nav — readiness for a group-managed Summary (U5)', () => {
    it('refuses the tick while a group is unwritten, however clean the four written ones look', () => {
        expect(summaryReadyForReview(summaryPhase())).toBe(false);
    });

    it('refuses the tick while the phrase read has not landed, and grants it when the rows arrive (R-T2/F1)', () => {
        // THE PROBE SCENARIO as the rail sees it: a grouped Story at the Summary phase, Goal passing, Ideas
        // empty, phrase read absent. Every readiness clause counts ROWS, and `phraseGroups` answers `[]` for a
        // read that has not landed, so all four passed and the rail ticked a five-group Overview it had never
        // seen. The Accept button sat under that tick for the same reason — `lockCheck` counts the same rows —
        // and `story-contract.groups.test.ts` pins the gate half of this same frame.
        const inFlight = { ...summaryPhase(), phrase: undefined };

        expect(phraseLoaded(inFlight)).toBe(false);
        expect(summaryReadyForReview(inFlight)).toBe(false);
        // The rail has no group rows to tick in that frame either: it shows its one loading line, and a ready
        // mark over it would be a verdict about rows the desk has not read.
        expect(summaryGroupEntries(inFlight)).toEqual([]);

        // A FAILED read answers the same way (F2): the absence is not "not yet", but it is still an absence.
        expect(summaryReadyForReview({ ...inFlight, phraseError: '503: the phrase read is offline' })).toBe(false);

        // THE OTHER HALF OF THE REQUIREMENT: the moment the actual groups arrive, readiness is the book's own
        // answer again — five clean written groups with nothing open is ready, which the frame above could not
        // claim either way.
        const arrived = { ...summaryPhase(), phrase: groupedPhraseView('s1') };

        expect(phraseLoaded(arrived)).toBe(true);
        expect(summaryGroupEntries(arrived).map((entry) => entry.group.title)).toEqual([
            'Premise',
            'Promise',
            'Theme',
            'Tone',
            'Ending'
        ]);
        expect(summaryReadyForReview(arrived)).toBe(true);
    });

    it('refuses it while a Writer is holding a group, because the text is about to move (R4)', () => {
        const base = groupedPhraseView('s1');
        const busy = fixtureView({
            phrase: {
                ...base,
                groups: base.groups.map((group) =>
                    group.key === 'theme' ? { ...group, writer_busy: true } : group
                )
            }
        });

        expect(summaryReadyForReview({ ...busy, ...summaryPhase(), phrase: busy.phrase })).toBe(false);
    });

    it('grants the tick over a finding at a blocking cost, because the accept voids it (R2, L-36)', () => {
        // THE REPLACED PIN: this frame used to answer `false`, which is the rail agreeing with a greyed Accept
        // over a defect the click itself clears. The finding is NOT hidden — it is counted into the statement
        // the control prints — and the tick and the button still answer the same thing, which is the half of
        // the requirement that never relaxed.
        const base = groupedPhraseView('s1');
        const view = summaryPhase();
        const withFinding = {
            ...view,
            phrase: {
                ...base,
                findings: [
                    {
                        id: 'f-1',
                        title: 'the promise names a cost the premise never sets up',
                        cost: 'critical' as const,
                        state: 'confirmed' as const,
                        seen_count: 1,
                        group_refs: ['grp-promise'],
                        unscoped: false,
                        targeted: ['grp-promise'],
                        resolved: [],
                        missing: ['grp-promise'],
                        resolved_all: false
                    }
                ]
            }
        };

        expect(summaryReadyForReview(withFinding)).toBe(true);
        expect(lockCheck(withFinding).canLock).toBe(true);
        expect(lockCheck(withFinding).statement).toContain('voids 1 open finding on the Summary phrase');

        // The same book with only a MINOR note: still ticked, and the note is STILL counted as an open row the
        // accept voids — the leftover count is never the Summary's cost bar, so the line under the control
        // agrees with the Overview's status line about cost. It is NOT the same number as that line in STATES
        // either: the accept books the rows the sweep discards, and the band below stops at three of them.
        const noteOnly = {
            ...withFinding,
            phrase: {
                ...withFinding.phrase!,
                findings: withFinding.phrase!.findings.map((finding) => ({ ...finding, cost: 'minor' as const }))
            }
        };

        expect(summaryReadyForReview(noteOnly)).toBe(true);
        expect(lockCheck(noteOnly).canLock).toBe(true);
        expect(lockCheck(noteOnly).statement).toContain('voids 1 open finding on the Summary phrase');

        // THE `disputed` ROW: not in the rail's open set, not in the Overview's review band (U5 files a dispute as
        // archived), and STILL voided by the click — `phrase/locks.ts:VOIDABLE_FINDING_STATES` takes it, because
        // D-33c reads a dispute as a live claim about text that has just stopped being writable. So the line
        // under the control counts the act, not the band: this book's review number is 0 and its accept number is
        // 1, and the pre-fix copy printed no clause at all while the receipt answered `voided_findings: 1`.
        const disputed = {
            ...withFinding,
            phrase: {
                ...withFinding.phrase!,
                findings: withFinding.phrase!.findings.map((finding) => ({ ...finding, state: 'disputed' as const })),
                review: { ...base.review, open_findings: 0, blocking_findings: 0 }
            }
        };

        expect(summaryReadyForReview(disputed)).toBe(true);
        expect(lockCheck(disputed).canLock).toBe(true);
        expect([disputed.phrase!.review.open_findings, disputed.phrase!.review.blocking_findings]).toEqual([0, 0]);
        expect(lockCheck(disputed).statement).toContain('voids 1 open finding on the Summary phrase');
    });

    it('grants the tick over the queue’s open work, and keeps it over the work already closed (R2, L-25b)', () => {
        const base = groupedPhraseView('s1');
        const view = summaryPhase();

        // `groupedPhraseView` ships no open tasks, no findings and every group written → ready.
        expect(summaryReadyForReview({ ...view, phrase: base })).toBe(true);

        const withTask = {
            ...view,
            phrase: {
                ...base,
                tasks: [
                    {
                        id: 't-1',
                        title: 'rewrite Theme to answer the promise it borrows',
                        state: 'open' as const,
                        owner_role: 'writer' as const,
                        attempts: 0,
                        finding_ref: null
                    }
                ]
            }
        };

        // THE REPLACED PIN, and the reported defect's second half: an open task held the tick AND the button
        // shut, and a `wontfix` one held them shut forever after.
        expect(summaryReadyForReview(withTask)).toBe(true);
        expect(lockCheck(withTask).canLock).toBe(true);
        expect(lockCheck(withTask).statement).toContain('closes 1 open task in the queue as wontfix');

        // A `done` row is not open work, and neither is a `wontfix` one: neither is named in the line, which is
        // the count the Author would otherwise read as "work the click still owes".
        for (const state of ['done', 'wontfix'] as const) {
            const settled = {
                ...withTask,
                phrase: { ...withTask.phrase!, tasks: withTask.phrase!.tasks.map((task) => ({ ...task, state })) }
            };

            expect(summaryReadyForReview(settled)).toBe(true);
            expect(lockCheck(settled).statement).not.toContain('closes');
        }

        // …and the open states are ALL accounted for, in the wire's set (`open`/`claimed`/`blocked`).
        const unfinished = {
            ...withTask,
            phrase: {
                ...withTask.phrase!,
                tasks: (['open', 'claimed', 'blocked'] as const).map((state, index) => ({
                    ...withTask.phrase!.tasks[0],
                    id: `t-${index}`,
                    state
                }))
            }
        };

        // D-78 keeps the tick over every one of them — a `blocked` row is no more a blocker than an `open` one
        // — but U-16 splits the SENTENCE: the sweep takes `open`/`claimed` (`loop/types.ts:OPEN_TASK_STATES`,
        // the set `loop/records.ts:wontfixTasks` walks), so the "closes" clause counts 2 and the blocked row is
        // named as what the click LEAVES rather than folded into the closed count.
        expect(summaryReadyForReview(unfinished)).toBe(true);
        expect(lockCheck(unfinished).statement).toContain('closes 2 open tasks in the queue as wontfix');
        expect(lockCheck(unfinished).statement).toContain('leaves 1 blocked task for you');
        expect(lockCheck(unfinished).statement).not.toContain('closes 3 open tasks');
    });

    // -----------------------------------------------------------------------
    // T13 / AC5 — the tick and the button are ONE fact.
    //
    // `summaryReadyForReview`'s grouped branch now delegates to the gate itself (`story-nav.ts` explains why a
    // second hand-written clause list is what drifted last time), and these cases pin the agreement in BOTH
    // directions rather than asserting one side and trusting the other: a `true` tick over a disabled button is
    // the reported bug, and a `false` tick over an enabled button is the one flipping it would produce.
    // -----------------------------------------------------------------------
    describe('the rail tick and the Accept button cannot disagree (AC5)', () => {
        /** The Sign-off frame around one of the reviewed fixture's states. */
        const frame = (state: 'pending' | 'ready' | 'chosen' | 'stale' | 'writer_busy') =>
            summaryPhase({ phrase: reviewedPhraseView('s1', state) });

        it('answers the same way for every reviewed state the wire sends', () => {
            const cases = [
                ['ready', true],
                ['stale', true],
                ['chosen', true],
                ['pending', false],
                // R4 — a clean selection the Writer is about to move is not signable in either surface.
                ['writer_busy', false]
            ] as const;

            for (const [state, expected] of cases) {
                const view = frame(state);

                expect(summaryReadyForReview(view), state).toBe(expected);
                expect(lockCheck(view).canLock, state).toBe(expected);
            }
        });

        it('answers the same way over the leftovers the accept clears', () => {
            const clean = frame('ready');
            const withLeftovers = {
                ...clean,
                phrase: {
                    ...clean.phrase!,
                    findings: [
                        {
                            id: 'f-open',
                            title: 'the Ending contradicts the promise it opens on',
                            cost: 'major' as const,
                            kind: 'issue' as const,
                            state: 'approved' as const,
                            seen_count: 1,
                            group_refs: ['grp-tone'],
                            unscoped: false,
                            targeted: ['grp-tone'],
                            resolved: [],
                            missing: ['grp-tone'],
                            resolved_all: false
                        }
                    ],
                    tasks: [
                        {
                            id: 't-open',
                            title: 'close out the tone the premise implies',
                            state: 'claimed' as const,
                            owner_role: 'writer' as const,
                            attempts: 1,
                            finding_ref: 'f-open'
                        }
                    ]
                }
            };

            expect(summaryReadyForReview(withLeftovers)).toBe(true);
            expect(lockCheck(withLeftovers).canLock).toBe(true);
            // …and the leftovers are visible where R2 put them: in the line the control prints.
            expect(lockCheck(withLeftovers).statement).toContain('voids 1 open finding on the Summary phrase');
            expect(lockCheck(withLeftovers).statement).toContain('closes 1 open task in the queue as wontfix');
        });

        it('answers the same way for the two waits the server really refuses on', () => {
            const clean = frame('ready');
            const goal = fixtureGoal();
            const failing = {
                ...clean,
                goal: { ...clean.goal, failing: goal.failing, phase_progress: goal.phase_progress }
            };
            const [proposal] = fixtureIdeas().filter((idea) => idea.state === 'proposed');
            const tray = { ...clean, ideas: [{ ...proposal, id: 'i-here', phase: 'summary' as const }] };

            for (const view of [failing, tray]) {
                expect(summaryReadyForReview(view)).toBe(false);
                expect(lockCheck(view).canLock).toBe(false);
            }
        });

        it('keeps the signed Summary ticked, and raises no group blocker over it, in either direction (L-30)', () => {
            // THE POST-LOCK CASE. The rail's rule is deliberate: a signed artifact keeps its mark, and the gate
            // switches its group clauses off for the same reason — the accept has already happened. So the pair
            // still agrees, just on the other side of the button.
            const signed = summaryPhase({ locked: true, failing: true });

            expect(signed.story.summary_locked).toBe(true);
            expect(summaryReadyForReview(signed)).toBe(true);
            // The GATE — the surface the button reads — is what stops naming the group's waits once the book is
            // signed (`lockCheck` skips `groupSignOffBlockers` for a locked Summary), because "no clean Summary
            // to accept yet" over a Summary that WAS accepted is the lie this case rules out. The derivation
            // itself still reports them, which is honest: the rows say what they say, and the gate decides.
            expect(groupSignOffBlockers(signed)).toHaveLength(3);
            expect(lockCheck(signed).reasons.some((reason) => reason.includes('no clean Summary'))).toBe(false);
            expect(lockCheck(signed).reasons.some((reason) => reason.includes('Summary group'))).toBe(false);
            // The signed book's statement is the lock's own line, not the accept's: the acts are done, and the
            // auto-start promise would describe a click that cannot happen twice.
            expect(lockCheck(signed).statement).toBe(
                'Locking the Summary makes it read-only for every agent (P5, L-30) and deletes this phase\u2019s Ideas tray in the same commit (D-36).'
            );
            // The one line left is the phase Goal, which is not the accept's bar and is the only reason the two
            // surfaces may answer differently here: the tick reports the signed artifact, the gate reports the
            // phase's own waits.
            expect(lockCheck(signed).reasons).toEqual(['the Goal has not passed: C-8 still failing (4/4)']);
        });

        it('withholds both while the phrase read has not landed, and grants both when the rows arrive (F1)', () => {
            const inFlight = { ...frame('ready'), phrase: undefined };

            expect(summaryReadyForReview(inFlight)).toBe(false);
            expect(lockCheck(inFlight).canLock).toBe(false);
            expect(lockCheck(inFlight).reasons).toEqual([
                'the Summary group rows have not been read yet — the sign-off waits for the phrase read to answer'
            ]);
        });
    });

    it("grants it to a Summary the Author has already signed, whatever the rows say (L-30's read)", () => {
        expect(summaryReadyForReview(summaryPhase({ locked: true, failing: true }))).toBe(true);
    });

    it('never reads the sampler’s numbers for a grouped book (U3)', () => {
        // The sampling fields are the ones a grouped Story never runs. Present, absent, settled or in
        // flight, they cannot change a grouped book's answer.
        const view = summaryPhase();
        const phrase = groupedPhraseView('s1');

        expect(summaryReadyForReview({ ...view, phrase, sampling: { round: 1, active_round: 2, history: [] } })).toBe(
            true
        );
        expect(
            summaryReadyForReview({
                ...view,
                phrase,
                sampling: { round: 4, active_round: 5, history: [] },
                revisions: []
            })
        ).toBe(true);
    });
});

describe('story-nav — the rail marks the group that owes work (U5)', () => {
    it('marks every group a blocking finding names, by its ref and with the badge-free label', () => {
        const marks = storyAttention(midReview()).filter((item) => item.panel === 'summary');

        expect(marks.map((item) => [item.ref, item.label, item.tone])).toEqual([
            ['summary-group:grp-premise', 'open findings to answer', 'awaiting'],
            ['summary-group:grp-promise', 'open findings to answer', 'awaiting'],
            ['summary-group:grp-theme', 'open findings to answer', 'awaiting'],
            ['summary-group:grp-tone', 'open findings to answer', 'awaiting'],
            // Ending is unwritten AND named by the unscoped finding, so its row carries the mark too.
            ['summary-group:grp-ending', 'open findings to answer', 'awaiting']
        ]);
        // The label carries NO number: the badge on the same row already carries the count and what it
        // means, and an accessible name concatenates both. Doubling it made the row read "…1 open finding
        // 1 open finding on Premise" (U7).
        expect(marks.every((item) => !/[0-9]/.test(item.label))).toBe(true);
    });

    it('marks nothing when a clean book has nothing open, and nothing for a fixed finding (U5)', () => {
        expect(storyAttention(fixtureView({ phrase: groupedPhraseView('s1') })).filter((i) => i.panel === 'summary')).toEqual(
            []
        );
        // The fixture's `fixed` finding targets Premise; a fixed row is archived out of every active list.
        expect(
            attentionFor(midReview(), 'summary', summaryGroupRef('grp-premise'))?.label
        ).toBe('open findings to answer');
        const onlyFixed = {
            ...midReview(),
            phrase: {
                ...fixturePhrase(),
                findings: fixturePhrase().findings.filter((finding) => finding.state === 'fixed')
            }
        };

        expect(storyAttention(onlyFixed).filter((item) => item.panel === 'summary')).toEqual([]);
    });

    it('resolves the mark for one row, which is what the rail paints', () => {
        const view = midReview();

        expect(attentionFor(view, 'summary', summaryGroupRef('grp-tone'))?.tone).toBe('awaiting');
        expect(attentionFor(view, 'summary', summaryGroupRef('grp-nothing'))).toBeUndefined();
        // The Overview header itself carries no group mark — the work is named on the group's own row.
        expect(attentionFor(view, 'summary', undefined)).toBeUndefined();
    });
});

describe('story-nav — a directive about a group addresses the group (U5)', () => {
    it('sends the group UUID as the ref and names the path in the label', () => {
        expect(
            directiveFocus(midReview(), { panel: 'summary', ref: summaryGroupRef('grp-theme') })
        ).toEqual({
            label: 'Summary → Theme → Editor',
            target: 'the Theme group of the Summary',
            placeholder: 'e.g. rewrite the theme · keep the rest of the Overview',
            refs: ['grp-theme']
        });
    });

    it('addresses the whole Summary from the header selection, with no group ref', () => {
        expect(directiveFocus(midReview(), DEFAULT_STORY_SELECTION)).toEqual({
            label: 'Summary → Editor',
            target: 'the Summary',
            placeholder: 'e.g. tighten the premise · keep the ending',
            // The legacy artifact still owns the ref while it exists; a grouped book with no legacy
            // Summary falls back to the phrase id, which is the address the loop reads.
            refs: ['sum1']
        });
        const noLegacy = {
            ...midReview(),
            summary: null
        };

        expect(directiveFocus(noLegacy, DEFAULT_STORY_SELECTION).refs).toEqual(['ph-1']);
    });

    it('falls back to the whole Summary when the ref names a group that is gone', () => {
        expect(directiveFocus(midReview(), { panel: 'summary', ref: summaryGroupRef('grp-retired') }).refs).toEqual(
            ['sum1']
        );
    });
});

// ---------------------------------------------------------------------------
// T-W4 — Phrase ②'s rail model, pinned next to the Summary's because it is the SAME model with a different
// prefix and a different row source. A chapter entry's address is `plotlines-group:<uuid>`; the two prefixes
// never cross, because the panel decides which surface to open and a parser that accepted either would open the
// wrong pane from a correct id. The marks come from the phrase read (`GET /stories/:id/phrases/plotlines`), and
// the readiness mark comes from the story's two projected flags — never from a row count, because a phrase that
// has not started and a phrase whose read failed both have zero rows.
// ---------------------------------------------------------------------------
describe('story-nav — Phrase ② addresses a chapter entry, and the rail reads the flags (T-W4)', () => {
    /**
     * The grouped book with Phrase ②'s facts set by the caller. `detail` is the phrase read: a `PhraseDetailView`
     * (landed), `null` (failed) or absent (never fetched). The three T-W4 fields sit on the STORY VIEW
     * (`api.ts:StoryView`), not on `story`, except the dial's row value, which `isPlotlinesGroups` reads first.
     */
    function phraseTwo(
        over: {
            mode?: 'groups' | 'classic';
            started?: boolean;
            compiled?: boolean;
            detail?: PhraseDetailView | null;
        } = {}
    ): StoryViewData {
        const view = fixtureView({ phrase: fixturePhrase() });

        return {
            ...view,
            plotlines_mode: over.mode ?? 'groups',
            phrase_started: { summary: true, plotlines: over.started === true },
            summary_compiled: over.compiled === true,
            story: { ...view.story, plotlines_mode: over.mode ?? 'groups' },
            ...(over.detail === null
                ? { phraseDetailError: 'the gateway is not answering' }
                : over.detail === undefined
                  ? {}
                  : { phraseDetail: over.detail })
        };
    }

    /**
     * The chapter-entry read with the marks a real book carries: Chapter 1 has one blocking finding and one
     * proposal the Author has approved (open, but not a blocker — U4's badges), Chapter 2 is held by a live
     * Writer pass, and Chapter 3 has never been written. Chapter 1 also carries the lock, which the rail prints
     * as a word and the pane prints as a badge — both from the same row.
     */
    function entryRead(): PhraseDetailView {
        const base = phraseDetailView('s1');

        return {
            ...base,
            groups: base.groups.map((row) =>
                row.key === 'chapter_1'
                    ? { ...row, locked: true, locked_by: 'author', locked_revision: 1 }
                    : row.key === 'chapter_2'
                      ? { ...row, writer_busy: true }
                      : {
                            ...row,
                            revision: 0,
                            content: '',
                            previous_content: '',
                            history: [],
                            writer_busy: false
                        }
            ),
            findings: [
                {
                    id: 'f-chapter-cross',
                    title: 'chapter 2 pays a price chapter 1 never sets up',
                    cost: 'critical',
                    kind: 'issue',
                    state: 'confirmed',
                    seen_count: 2,
                    group_refs: ['entry-chapter_1'],
                    unscoped: false,
                    targeted: ['entry-chapter_1'],
                    resolved: [],
                    missing: ['entry-chapter_1'],
                    resolved_all: false
                },
                {
                    id: 'f-chapter-note',
                    title: 'chapter 1 restates the brief in other words',
                    cost: 'minor',
                    kind: 'proposal',
                    state: 'approved',
                    seen_count: 1,
                    group_refs: ['entry-chapter_1'],
                    unscoped: false,
                    targeted: ['entry-chapter_1'],
                    resolved: [],
                    missing: ['entry-chapter_1'],
                    resolved_all: false
                },
                {
                    id: 'f-chapter-fixed',
                    // A `fixed` row is in no active list: no badge, no rail mark (U5's rule, restated here for
                    // the second phrase so a row of THIS surface cannot leak one).
                    title: 'the crossing was already attempted',
                    cost: 'critical',
                    kind: 'issue',
                    state: 'fixed',
                    seen_count: 4,
                    group_refs: ['entry-chapter_1'],
                    unscoped: false,
                    targeted: ['entry-chapter_1'],
                    resolved: ['entry-chapter_1'],
                    missing: [],
                    resolved_all: true
                }
            ]
        };
    }

    it('addresses an entry by its id, and never resolves the other phrase’s prefix', () => {
        expect(plotlineGroupRef('entry-chapter_1')).toBe('plotlines-group:entry-chapter_1');
        expect(parsePlotlineGroupRef('plotlines-group:entry-chapter_1')).toBe('entry-chapter_1');
        // The prefixes are the only thing that tells the two surfaces apart, so neither parser may accept the
        // other's id: a uuid that resolves in both panes is how a rail click opens the wrong contract.
        expect(parsePlotlineGroupRef(summaryGroupRef('grp-promise'))).toBeUndefined();
        expect(parseSummaryGroupRef(plotlineGroupRef('entry-chapter_1'))).toBeUndefined();
        // An empty id is not an entry, and neither is an absent ref (the header's selection).
        expect(parsePlotlineGroupRef('plotlines-group:')).toBeUndefined();
        expect(parsePlotlineGroupRef(undefined)).toBeUndefined();
    });

    it('resolves the entry the ref names — by id, never by row position — and only on Phrase ②’s panel', () => {
        const view = phraseTwo({ started: true, detail: phraseDetailView('s1') });

        // The rows arrive in composition order; a ref naming the middle row must still find the middle row's
        // CONTRACT even when the server sends them in another order (the same U2 rule the Summary's rows follow).
        const reversed: StoryViewData = {
            ...view,
            phraseDetail: { ...view.phraseDetail!, groups: [...view.phraseDetail!.groups].reverse() }
        };

        expect(plotlineGroupFocus(view, { panel: 'plotlines', ref: plotlineGroupRef('entry-chapter_2') })?.title).toBe(
            'Chapter 2 — The Salt Road'
        );
        expect(
            plotlineGroupFocus(reversed, { panel: 'plotlines', ref: plotlineGroupRef('entry-chapter_2') })?.title
        ).toBe('Chapter 2 — The Salt Road');
        // The header's selection names no entry, a ref naming no row names none, and a Phrase ② ref handed to
        // another panel is ignored rather than guessed at.
        expect(plotlineGroupFocus(view, { panel: 'plotlines' })).toBeUndefined();
        expect(plotlineGroupFocus(view, { panel: 'plotlines', ref: plotlineGroupRef('gone') })).toBeUndefined();
        expect(
            plotlineGroupFocus(view, { panel: 'summary', ref: plotlineGroupRef('entry-chapter_2') })
        ).toBeUndefined();
    });

    it('rows the entries the rail paints, with the counts and marks the row itself reports', () => {
        const rows = plotlineRailEntries(phraseTwo({ started: true, detail: entryRead() }));

        // (ref, title, blocking, open, writer holds it, written, locked) — the whole list, so a reorder or a
        // count derived from the wrong read fails. Chapter 1 badges ONE (the critical issue): the approved
        // proposal is open but costs nothing, and the `fixed` row is in no list at all.
        expect(
            rows.map((row) => [
                row.ref,
                row.entry.title,
                row.blockingFindings,
                row.openFindings,
                row.writerBusy,
                row.written,
                row.locked === true,
                row.lockedBy,
                row.lockedRevision
            ])
        ).toEqual([
            ['plotlines-group:entry-chapter_1', 'Chapter 1 — The Salt Road', 1, 2, false, true, true, 'author', 1],
            ['plotlines-group:entry-chapter_2', 'Chapter 2 — The Salt Road', 0, 0, true, true, false, undefined, undefined],
            ['plotlines-group:entry-chapter_3', 'Chapter 3 — The Salt Road', 0, 0, false, false, false, undefined, undefined]
        ]);

        // The lock's keys are ABSENT on an unlocked row rather than `false`/`null`: the rail renders nothing for
        // an absent mark, and a row that printed `undefined` would put a word in the accessible name.
        expect(Object.keys(rows[1]!).sort()).toEqual(
            ['blockingFindings', 'entry', 'openFindings', 'ref', 'writerBusy', 'written'].sort()
        );
    });

    it('rows nothing for a book whose Phrase ② has no chapter entries (the classic records stay in the pane)', () => {
        // A classic book's `view.plotlines` records are the OTHER surface (§4.3), and putting them in the rail as
        // well would put two Plotlines lists on one screen. The rail asks the Setting, not the record count.
        expect(plotlineRailEntries(phraseTwo({ mode: 'classic' }))).toEqual([]);
        // Started on the grouped pipeline, read not landed: no rows yet, which the rail's pending line owns.
        expect(plotlineRailEntries(phraseTwo({ started: true }))).toEqual([]);
    });

    it('prompts the handoff exactly between “compiled” and “started”, and reads the surface from the flags', () => {
        // The four states of the rail's mark. `plotlinesRailSurfaceOpen` is the wider question — is there a
        // chapter-entry surface to open at all — and it answers true for either flag.
        expect(
            [
                plotlinesReadyToStart(phraseTwo({ compiled: true, started: false })),
                plotlinesReadyToStart(phraseTwo({ compiled: true, started: true })),
                plotlinesReadyToStart(phraseTwo({ compiled: false, started: false })),
                plotlinesReadyToStart(phraseTwo({ compiled: false, started: true }))
            ]
        ).toEqual([true, false, false, false]);

        expect(
            [
                plotlinesRailSurfaceOpen(phraseTwo({ started: true, mode: 'classic' })),
                plotlinesRailSurfaceOpen(phraseTwo({ started: false, mode: 'groups' })),
                plotlinesRailSurfaceOpen(phraseTwo({ started: false, mode: 'classic' }))
            ]
        ).toEqual([true, true, false]);
    });

    it('names Phrase ② and its entry for the pane’s heading, and Characters with no phrase number', () => {
        const view = phraseTwo({ started: true, detail: phraseDetailView('s1') });

        expect(selectionTitle(view, { panel: 'plotlines' })).toBe('Phrase 2 — Plotlines');
        expect(selectionTitle(view, { panel: 'plotlines', ref: plotlineGroupRef('entry-chapter_1') })).toBe(
            'Phrase 2 — Plotlines · Chapter 1 — The Salt Road'
        );
        // An entry the read does not have falls back to the phrase's own title: the pane then says what it is
        // looking at rather than inventing a row.
        expect(selectionTitle(view, { panel: 'plotlines', ref: plotlineGroupRef('gone') })).toBe(
            'Phrase 2 — Plotlines'
        );
        // The supplementary sheet keeps its title with NO number — the exact claim T-W4 retires.
        expect(selectionTitle(view, { panel: 'characters' })).toBe('Characters');
        expect(STORY_SUPPLEMENTS.map((sheet) => [sheet.key, sheet.title])).toEqual([['characters', 'Characters']]);
    });

    it('keeps an entry selected while its read is in flight, and drops it once the rows say it is gone', () => {
        const landed = phraseTwo({ started: true, detail: phraseDetailView('s1') });

        expect(selectionExists(landed, { panel: 'plotlines', ref: plotlineGroupRef('entry-chapter_3') })).toBe(true);
        expect(selectionExists(landed, { panel: 'plotlines', ref: plotlineGroupRef('retired') })).toBe(false);
        // Not landed (in flight, or the read failed): an unread entry is not a deleted entry, so the selection
        // holds and the pane shows its loading line — the same U6 rule as a Summary group.
        expect(
            selectionExists(phraseTwo({ started: true }), { panel: 'plotlines', ref: plotlineGroupRef('retired') })
        ).toBe(true);
        expect(
            selectionExists(phraseTwo({ started: true, detail: null }), {
                panel: 'plotlines',
                ref: plotlineGroupRef('retired')
            })
        ).toBe(true);
        // A bare uuid on this panel is still a classic §4.3 record, and resolves against `view.plotlines`.
        expect(selectionExists(landed, { panel: 'plotlines', ref: landed.plotlines[0]!.id })).toBe(true);
        expect(selectionExists(landed, { panel: 'plotlines', ref: 'no-such-record' })).toBe(false);
    });
});
