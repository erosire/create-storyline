// The decision machine: what one Story's status becomes after one sweep, and why (D-2a, §6.6, §9).
//
// The order below IS the precedence the spec fixes, and most of the acceptance rows are about it:
//   1. the Author's own switch wins over everything (`author_stop`, `status: stopped` — P8, D-37b);
//   2. a phase whose Goal passes stops at the sign-off (L-29) — except phase `chapters`, which never
//      waits on a sign-off (L-35: phase ③ ends when it DRAINS, and the Story ends when the Author
//      accepts, L-26);
//   3. `drained` is tested before `stalled` and wins (L-37a) — a Story that has run out of authorised
//      work has exactly the flat signature L-21 reads as "stuck", and calling it stuck is the exact
//      defect L-37a names;
//   4. the by-design Author waits (`idea_selection`, `finding_approval`) begin only when NOTHING ELSE
//      is dispatchable (L-36: an unapproved finding is a pending decision, not a blocked Story);
//   5. `stalled` (L-21) — the only `pending` that means trouble (L-34);
//   6. otherwise `ready`, and the sweep dispatches.
//
// `status_reason` is written to L-22's standard on every branch: name the artifact, the level, the
// criteria, the fingerprint, the chapters. The row the Author reads IS this string, so a vague string
// here is a spec violation rather than a style problem.
import {
    dialCovers,
    dialKey,
    dispatchableTasks,
    findingsAwaitingAuthor,
    findingsCreatedSince,
    ideasToVerify,
    last,
    latestJournalSeq,
    loopStory,
    repeatIdeas,
    storyIdeas,
    undecidedIdeas,
    storyFindings,
    unconfirmedFindings,
    unitsWithCompetingRevisions
} from './records';
import { isStalled, renderPairs, stalledReason, type RoundDelta } from './trend';
import type { CompletionProposal, LoopStory, ProbeState } from './types';
import type { GoalStatus, LevelReport } from '../criteria/engine';
import type { Cost, Finding, Goal, Idea, PendingKind, Story, StoryPhase, StoryStatus } from '../../shared/types';
import type { Store } from '../store';

/** What `decideStory` concluded, in the form the sweep writes and the report renders. */
export interface StoryDecision {
    status: StoryStatus;
    pending_kind: PendingKind;
    status_reason: string;
    /** §4.1's `blocked_on`: the short thing the tree renders; empty when nothing is held up. */
    blocked_on: string;
    /** L-0: may this Story receive work this sweep? */
    dispatch: boolean;
    /** The probe state to persist, or `undefined` to leave the stored one alone. */
    probe?: ProbeState;
    /** Set when this sweep raises the completion proposal (L-25). */
    completion?: CompletionProposal;
    /** The branch taken, for the sweep report and for a test that wants the reason without the prose. */
    why: string;
}

/** The inputs the decision needs, gathered once per Story per sweep so nothing is read twice. */
export interface DecisionInput {
    goal: Goal;
    goalStatus: GoalStatus;
    levels: LevelReport;
    levelPairs: Record<string, string>;
    delta: RoundDelta;
    /**
     * How many jobs the loop WOULD dispatch. L-36's wait only begins "when nothing else is
     * dispatchable", so the candidate list has to be computed before the decision is — this number is
     * that list's length, and it is the only reason `work.ts` runs first.
     */
    dispatchable: number;
}

// ---------------------------------------------------------------------------
// L-37's four conditions, and the probe that answers condition 3
// ---------------------------------------------------------------------------

/**
 * D-27: a sourced Idea still awaiting the Editor is the Ideas-tray twin of D-33's unconfirmed finding —
 * an Editor run the crew can start right now, and a precondition on the Author ever being able to pick
 * the Idea (C-15 refuses an unverified one). Counting it here is what stops the sweep reporting
 * `drained` (and refusing to start a probe round) while verification work is still in front of it: the
 * loop has NOT run out of authorised work, it has just not done this part yet.
 */
export const ideasAwaitingVerification = (store: Store, story: Story): Idea[] =>
    ideasToVerify(store, story.id, story.phase);

/**
 * L-37's conditions 1, 2 and 4 — everything except the fresh round, which is the probe's job.
 *
 * Condition 1 reads `open`/`claimed` tasks of a dispatchable kind ("no `approved` or `open` task
 * remains for a Writer"). A `blocked` task is the crew asking the Author something, which is what
 * `drained` MEANS — the loop cannot act without them — so it does not block drained. That reading is
 * what keeps an escalation from needing a `pending_kind` §4.1's enum does not have.
 */
export function drainPreconditions(store: Store, story: Story): { met: boolean; unmet: string[] } {
    const tasks = dispatchableTasks(store, story.id);
    const unconfirmed = unconfirmedFindings(store, story.id);
    const competing = unitsWithCompetingRevisions(store, story.id);
    const unverified = ideasAwaitingVerification(store, story);
    const unmet: string[] = [];

    if (tasks.length > 0) unmet.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'} still queued`);
    if (unconfirmed.length > 0)
        unmet.push(`${unconfirmed.length} finding${unconfirmed.length === 1 ? '' : 's'} still unconfirmed (D-33)`);
    if (competing.length > 0)
        unmet.push(
            `${competing.length} unit${competing.length === 1 ? '' : 's'} with competing drafts awaiting an Editor (D-23)`
        );
    if (unverified.length > 0)
        unmet.push(
            `${unverified.length} sourced Idea${unverified.length === 1 ? '' : 's'} still awaiting the Editor's verdict (D-27)`
        );

    return { met: unmet.length === 0, unmet };
}

/** The dial as prose, for the drained reason (§15 step 11's "no critical or major left"). */
export function dialPhrase(story: Story): string {
    const order: Cost[] = ['critical', 'major', 'minor', 'taste'];
    const covered = order.filter((cost) => dialCovers(story, cost));

    if (covered.length === 0) return 'nothing';
    if (covered.length === 1) return covered[0];

    return `${covered.slice(0, -1).join(', ')} or ${last(covered)}`;
}

/** The dial as the sorted list `ProbeState.dial` stores, so a widened dial invalidates a round. */
export const dialKeyOf = (story: Story): string[] =>
    dialKey(story)
        .split(',')
        .filter((cost) => cost.length > 0)
        .sort();

/**
 * Does the stored probe still describe the current situation?
 *
 * It stops describing it when the phase moves (L-37's pass is per phase), when the dial is WIDENED
 * (D-35b: costs the crew was not previously allowed to work on are now work, so a round that found
 * none of them proves nothing), or when the preconditions broke after the round (new work appeared, so
 * the round was no longer "a single full pass over the Story" — L-37's own words).
 *
 * NARROWING the dial deliberately does not invalidate a clean round: a round that found nothing at
 * {critical, major} has by construction found nothing at {critical} alone. That is why §15 step 11a's
 * "raise the dial to `critical` only and watch the same Story drain sooner" resolves immediately
 * instead of costing a fresh round.
 */
export function probeIsLive(story: Story, phase: StoryPhase, dial: string[], preconditionsMet: boolean): boolean {
    const probe = loopStory(story).probe;

    if (probe === undefined || !preconditionsMet) return false;
    if (probe.phase !== phase) return false;
    if (probe.status !== 'clean') return false;
    if ([...probe.dial].sort().join(',') === [...dial].sort().join(',')) return true;

    // True only when the stored dial is a SUBSET of the current one — i.e. nothing was removed, so the
    // round's evidence still covers the threshold now in force.
    return probe.dial.every((cost) => dial.includes(cost));
}

/** Starts a fresh round (L-37's condition 3): the watermark is the journal's high-water mark. */
export function startProbe(store: Store, story: Story, phase: StoryPhase, at: string): ProbeState {
    return {
        status: 'running',
        phase,
        checker_item_id: null,
        reader_item_id: null,
        // The watermark is the journal's `seq` and not a timestamp: one sweep commits dozens of times
        // and two commits can share a millisecond, so a clock comparison would silently assign a
        // finding to the wrong round. D-14 anchors staleness on the same number for the same reason,
        // and `seq` is the only ordering that survives a restart (L-3).
        journal_seq: latestJournalSeq(store),
        dial: dialKeyOf(story),
        started_at: at,
        clean_since: null
    };
}

/**
 * The round's verdict, once both probe runs have closed (the sweep calls this with the closed runs).
 *
 * L-37's condition 3 is about the DIAL, not about findings in general: a `minor` finding turned up by
 * a fresh Reader while the dial covers `critical`+`major` does NOT dirty the round — §15 step 11's
 * whole point is that the Story drains with 12 `minor` and 4 `taste` findings sitting open. Ideas
 * never dirty it either: an Idea is a proposal for the Author (D-26), not authorised work.
 */
export function judgeProbe(store: Store, story: Story, probe: ProbeState, at: string): ProbeState {
    const covered = findingsCreatedSince(store, story.id, probe.journal_seq).filter((finding) =>
        dialCovers(story, finding.cost)
    );

    if (covered.length > 0) return { ...probe, status: 'idle', clean_since: null };

    return { ...probe, status: 'clean', clean_since: at };
}

/** What the Author is being handed, for L-37's reason sentence and U-1c's exactly-two-moves. */
export interface Leftovers {
    findings: number;
    ideas: number;
    /** Confirmed findings the dial does not cover: approving one is the move that returns the Story to `ready`. */
    awaiting: number;
}

export function leftovers(store: Store, story: Story): Leftovers {
    const open = storyFindings(store, story.id).filter(
        (finding) => finding.state !== 'fixed' && finding.state !== 'discarded'
    );
    // U-14's "the Author accepts with their eyes open" only works when this is the number the accept
    // really throws away, so it reads the SAME set `acceptCompletion` iterates (below:
    // `DISCARDABLE_IDEA_STATES`, story-wide like the accept) rather than the strict `proposed` rows. A
    // `verified` / `refuted` / `unverifiable` Idea is still undecided — the Editor answered "is the claim
    // true?", never "is it in the book?" (T-3b) — and the accept discards it exactly as it discards a
    // `proposed` one, so counting only `proposed` under-stated the discard by every row the loop had
    // fact-checked. Same set `api/projections.ts:completionPreview` renders, so the drained row and the
    // Story view cannot disagree. `api/routes.ts`' lock gate and the queue read the phase's tray
    // (`records.ts:undecidedIdeas`); a locked phase never has an undecided row of its own left (L-7a,
    // D-36), so story-wide and per-phase agree for every reachable drained Story.
    const ideas = storyIdeas(store, story.id).filter((idea) => DISCARDABLE_IDEA_STATES.includes(idea.state));

    return {
        findings: open.length,
        ideas: ideas.length,
        awaiting: open.filter((finding) => finding.state === 'confirmed' && !dialCovers(story, finding.cost)).length
    };
}

// ---------------------------------------------------------------------------
// L-25's completion test
// ---------------------------------------------------------------------------

/**
 * L-25: drained PLUS every hard criterion passing at every reached level, no ledger `conflict` and no
 * setup left unpaid past its point, and the soft count at or above `threshold_soft`.
 *
 * L-25b is why this does NOT ask for an empty finding list: "a bar of zero open findings is a bar no
 * book clears". The Goal can pass with 16 findings open; what closes them is the Author's acceptance
 * (L-26), and the count is recorded so the Author can see what they waved away (U-14).
 *
 * `goalStatus.passed` already encodes "every hard passes AND soft >= threshold" (criteria/engine.ts's
 * `tally`), so the extra tests here are the two L-25 clauses the phase Goal does not consult: the
 * ledger's `conflict` flag and its unpaid setups (D-10, C-5).
 */
export function completionReady(store: Store, story: Story, goalStatus: GoalStatus): { met: boolean; unmet: string[] } {
    const unmet: string[] = [];

    if (!goalStatus.passed) unmet.push(`the phase Goal is ${goalStatus.progress}`);

    const conflicts = store.ledger.list().filter((entry) => entry.story_id === story.id && entry.status === 'conflict');

    if (conflicts.length > 0) unmet.push(`${conflicts.length} ledger entries in conflict (D-10)`);

    const unpaid = store.ledger
        .list()
        .filter((entry) => entry.story_id === story.id && entry.kind === 'setup' && entry.status === 'open');

    if (unpaid.length > 0) unmet.push(`${unpaid.length} setup${unpaid.length === 1 ? '' : 's'} with no payoff (C-5)`);

    return { met: unmet.length === 0, unmet };
}

/**
 * L-25's proposal, carrying L-25b's counts so U-14's prompt can state what accepting will discard.
 *
 * Idempotent per drain: the original `proposed_at` survives a re-raise so the row does not look
 * freshly proposed on every sweep, and nothing is raised again while the same counts are already
 * pending (a proposal that churned every sweep would re-page the Author for the same decision).
 */
export function raiseCompletion(store: Store, story: Story, at: string): CompletionProposal | undefined {
    const loop = loopStory(story);

    if (loop.completion?.accepted === true) return undefined;

    const left = leftovers(store, story);
    const pending = { findings: left.findings, ideas: left.ideas };

    if (
        loop.completion !== undefined &&
        loop.completion.leftovers.findings === pending.findings &&
        loop.completion.leftovers.ideas === pending.ideas
    ) {
        return undefined;
    }

    return {
        proposed_at: loop.completion?.proposed_at ?? at,
        phase: story.phase,
        leftovers: pending,
        accepted: false,
        // L-30: a discard survives the proposal being cleared, so the count carries forward.
        discarded: loop.completion?.discarded ?? 0
    };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * The one function that decides a Story's status, pure over the store plus what the sweep already
 * measured. It never writes: the sweep applies the result in a single commit, so a Story's status and
 * its reason always land together (P1).
 */
export function decideStory(store: Store, story: Story, input: DecisionInput, ctx: { at: string }): StoryDecision {
    const loop = loopStory(story);

    // 1. The Author's cord. P8: a stopped Story never auto-resumes, and D-37b says a pause is not a
    // mode the Story enters permanently — so the sweep reports the state and changes nothing.
    if (story.author_stop || story.status === 'stopped') {
        return {
            status: story.status,
            pending_kind: story.pending_kind,
            status_reason: story.status_reason || 'the Author has it stopped (P8, D-37)',
            blocked_on: 'the Author',
            dispatch: false,
            why: 'author_stop'
        };
    }

    // 2. A completed Story stays closed until the Author edits, a `needs_recheck` lands, or a directive
    // arrives (L-27) — all of which are verbs, not sweep decisions.
    if (story.status === 'completed') {
        return {
            status: 'completed',
            pending_kind: story.pending_kind,
            status_reason: story.status_reason || 'the Author accepted completion (L-26)',
            blocked_on: '',
            dispatch: false,
            why: 'completed'
        };
    }

    // L-33: a phase may not be entered unless every earlier phase is locked. The sweep reports the
    // breach instead of dispatching into it, and only the Author's lock can fix it (D-25, D-1).
    if (!phasesUnlockedOk(story)) {
        return {
            status: 'pending',
            pending_kind: 'phase_signoff',
            status_reason: `phase ${story.phase} is open while an earlier phase is unlocked (L-33) — lock ${earlierUnlockedPhase(story)} first`,
            blocked_on: 'an earlier lock',
            dispatch: false,
            why: 'phase_precondition'
        };
    }

    // L-29's one suppression (documented judgment call): while a unit's drafts are still competing,
    // the phase is not eligible to advance at all (L-20, D-23), so the lock is not offered yet and the
    // Editor's job keeps the Story `ready`. Signing off over unchosen drafts would put the choice in
    // the Author's hands by default rather than by decision.
    const competing = unitsWithCompetingRevisions(store, story.id);

    // D-27 / L-36: a sourced Idea the Editor has not verified is an EDITOR job the crew can start now,
    // not a decision only the Author can make. Offering the lock (or the Idea pick) over one would put
    // the Author in front of an Idea they are not allowed to select — the select gate refuses an
    // unverified sourced Idea (api/routes.ts, C-15) — so the wait is suppressed while verification is
    // owed and the sweep dispatches `verify_ideas` instead. The sign-off and the pick are unchanged as
    // the fallback: they fire on the next sweep, over a tray the Editor has actually answered.
    const verificationOwed = ideasAwaitingVerification(store, story).length;

    if (
        input.goalStatus.passed &&
        competing.length === 0 &&
        verificationOwed === 0 &&
        story.phase !== 'chapters' &&
        !phaseIsLocked(story)
    ) {
        const tray = undecidedIdeas(store, story.id, story.phase);

        // L-7a: the lock is not offered while the tray still holds an UNDECIDED Idea — "a locked artifact
        // with unjudged alternatives still in the tray is a decision the machine made by silence". The
        // Editor's verdict does not settle an Idea (T-3b): `verified`, `refuted` and `unverifiable` rows are
        // still the Author's to select, discard, or defer, so they hold the lock exactly as `proposed` ones
        // do. The wait is the Author's pick, not the lock.
        if (tray.length > 0) {
            return {
                status: 'pending',
                pending_kind: 'idea_selection',
                status_reason: `phase ${story.phase}'s Goal passes (${input.goalStatus.progress}) · ${tray.length} undecided Idea${tray.length === 1 ? '' : 's'} must be selected, discarded, or deferred before the lock (L-7a, D-29)`,
                blocked_on: `${tray.length} Idea${tray.length === 1 ? '' : 's'} in the tray`,
                dispatch: false,
                why: 'idea_selection'
            };
        }

        return {
            status: 'pending',
            pending_kind: 'phase_signoff',
            status_reason: signoffReason(story, input),
            blocked_on: lockLabel(story),
            dispatch: false,
            why: 'phase_signoff'
        };
    }

    // 3. Drained — tested before stalled, and it wins (L-37a).
    const pre = drainPreconditions(store, story);
    const dial = dialKeyOf(story);

    if (pre.met && probeIsLive(story, story.phase, dial, true)) {
        const left = leftovers(store, story);
        const completion = completionReady(store, story, input.goalStatus);

        return {
            status: 'pending',
            pending_kind: 'drained',
            status_reason: drainedReason(story, left, completion),
            blocked_on:
                left.awaiting > 0
                    ? `${left.awaiting} finding${left.awaiting === 1 ? '' : 's'} awaiting you`
                    : 'the Author: work the leftovers or accept completion',
            dispatch: false,
            completion: completion.met ? raiseCompletion(store, story, ctx.at) : undefined,
            why: 'drained'
        };
    }

    // 4. The by-design Author waits, and only when nothing else is dispatchable (L-36).
    if (input.dispatchable === 0) {
        // L-36's wait names the whole tray, not just the rows nobody has fact-checked yet: a `verified`
        // or `refuted` Idea is still an open Author decision, and calling the Story drained with one
        // sitting there would report "out of authorised work" while the lock stays refused (L-7a).
        const tray = undecidedIdeas(store, story.id, story.phase);
        const awaiting = findingsAwaitingAuthor(store, story);

        if (tray.length > 0 && awaiting.length === 0) {
            return {
                status: 'pending',
                pending_kind: 'idea_selection',
                status_reason: `${tray.length} undecided Idea${tray.length === 1 ? '' : 's'} in the tray and nothing else to dispatch · select or discard them (D-29, L-7a)`,
                blocked_on: `${tray.length} Idea${tray.length === 1 ? '' : 's'}`,
                dispatch: false,
                why: 'idea_selection'
            };
        }

        if (awaiting.length > 0) {
            const named = awaiting
                .slice(0, 3)
                .map((finding) => `${finding.cost} ${finding.fingerprint}`)
                .join(', ');

            return {
                status: 'pending',
                pending_kind: 'finding_approval',
                status_reason: `${awaiting.length} confirmed finding${awaiting.length === 1 ? '' : 's'} the dial (${dialPhrase(story)}) does not cover, and nothing else to dispatch: ${named} (D-34, L-36)`,
                blocked_on: `${awaiting.length} finding${awaiting.length === 1 ? '' : 's'} awaiting approval`,
                dispatch: false,
                why: 'finding_approval'
            };
        }

        // An escalation the crew asked for (P7) with nothing else to run. §4.1's enum has no
        // "question" kind and L-37's condition 1 does not count a `blocked` task as work, so the
        // honest reading is `drained` with the question named: the loop is out of authorised work and
        // only the Author can give it more.
        const question = store.tasks.list().find((task) => task.story_id === story.id && task.state === 'blocked');

        if (question !== undefined) {
            return {
                status: 'pending',
                pending_kind: 'drained',
                status_reason: `the crew asked you: "${question.title}" (P7) · nothing else is dispatchable (L-37)`,
                blocked_on: 'the Author: an open question',
                dispatch: false,
                why: 'escalation'
            };
        }
    }

    // 5. Stalled — the only `pending` that means trouble (L-21, L-34). Checked after drained, always
    // (L-37a), and it stops dispatch even though jobs may remain: that is the point of the state.
    if (isStalled(story, input.goal, input.delta)) {
        return {
            status: 'pending',
            pending_kind: 'stalled',
            status_reason: stalledReason(store, story, input.levels, input.goal),
            blocked_on: `${input.delta.trend} past the Goal's loop-detection limits`,
            dispatch: false,
            why: 'stalled'
        };
    }

    // 6. Ready. The reason line still carries the Goal's render (G-2) so the row is never blank, and
    // `blocked_on` names what is failing while the crew is merely busy rather than waiting.
    const staleClean = loop.probe !== undefined && loop.probe.status === 'clean' && !pre.met;
    const repeats = repeatIdeas(store, story.id, story.phase);

    return {
        status: 'ready',
        pending_kind: 'none',
        status_reason: input.goalStatus.passed
            ? `phase ${story.phase}'s Goal passes (${input.goalStatus.progress}) — the crew keeps working until it drains (L-35, L-36)${
                  verificationOwed > 0
                      ? ` · ${verificationOwed} sourced Idea${verificationOwed === 1 ? '' : 's'} first need the Editor's verdict (D-27)`
                      : ''
              }`
            : input.goalStatus.progress,
        blocked_on:
            repeats.length > 0
                ? `${repeats.length} repeat Idea${repeats.length === 1 ? '' : 's'} (D-32)`
                : input.levels.failing.length > 0
                  ? `failing: ${[...new Set(input.levels.failing)].join(', ')}`
                  : '',
        dispatch: true,
        // A clean round whose preconditions broke no longer describes this Story, so it is dropped
        // here and a fresh full pass is required before `drained` may be claimed again (L-37).
        probe:
            staleClean && loop.probe !== undefined ? { ...loop.probe, status: 'idle', clean_since: null } : undefined,
        why: 'ready'
    };
}

/** L-29's reason: name the artifact awaiting the lock, and the empty tray that makes it lockable. */
function signoffReason(story: Story, input: DecisionInput): string {
    return `phase ${story.phase}'s Goal passes (${input.goalStatus.progress}) · ${lockLabel(story)} awaits your lock · the Ideas tray is empty · the crew is stopped until you act (L-29)`;
}

function lockLabel(story: Story): string {
    return story.phase === 'summary' ? 'the Summary' : story.phase === 'plotlines' ? 'the plotlines' : 'the chapters';
}

/** §4.1's two lock flags, read against the phase the Story is standing in (L-33). */
function phasesUnlockedOk(story: Story): boolean {
    if (story.phase === 'plotlines') return story.summary_locked;
    if (story.phase === 'chapters') return story.summary_locked && story.plotlines_locked;

    return true;
}

function earlierUnlockedPhase(story: Story): string {
    return story.summary_locked ? 'the plotlines (L-7)' : 'the Summary (L-7a)';
}

/** An already-locked phase needs no sign-off, so the Goal-passing branch must not re-offer one. */
function phaseIsLocked(story: Story): boolean {
    return story.phase === 'summary'
        ? story.summary_locked
        : story.phase === 'plotlines'
          ? story.plotlines_locked
          : false;
}

/**
 * L-37's reason sentence in §15 step 11's shape: what stopped ("no critical or major left") and what
 * is left to the Author ("16 findings awaiting you"). U-1c asks that a drained row read as FINISHED
 * rather than idle, which is why it names the threshold the crew ran out of instead of a queue length.
 */
function drainedReason(story: Story, left: Leftovers, completion: { met: boolean; unmet: string[] }): string {
    const parts = [
        `no ${dialPhrase(story)} left to work on (D-35b)`,
        'a fresh round of Readers and checkers found nothing at that threshold (L-37)'
    ];

    if (left.awaiting > 0) parts.push(`${left.awaiting} finding${left.awaiting === 1 ? '' : 's'} awaiting you`);
    else if (left.findings > 0)
        parts.push(`${left.findings} finding${left.findings === 1 ? '' : 's'} below the threshold, left open`);

    // U-14's number, and it is the honest one: `leftovers` counts every row the accept will discard, so
    // an Idea the loop verified but the Author never picked is named here instead of vanishing from the
    // sentence the Author reads before clicking "Complete".
    if (left.ideas > 0)
        parts.push(
            `${left.ideas} undecided Idea${left.ideas === 1 ? '' : 's'} in the tray, which accepting discards (L-25b, U-14)`
        );

    parts.push(
        completion.met
            ? 'every hard criterion passes at every reached level — the loop proposes completion (L-25)'
            : `completion not proposed: ${completion.unmet.join(' · ')}`
    );

    return parts.join(' · ');
}

/** The finding states that count as "still open" for L-25b's discard sweep and U-14's count. */
export const DISCARDABLE_FINDING_STATES: Finding['state'][] = ['unconfirmed', 'confirmed', 'approved', 'disputed'];

/**
 * The Idea states L-25b discards on completion — everything not already absorbed by an artifact,
 * including the rows that only carry an Editor verdict (T-3b: `verified`/`refuted`/`unverifiable` are
 * still the Author's undecided tray). THE SINGLE SOURCE for the discard count: `engine.acceptCompletion`
 * moves exactly these rows, and `status.ts:leftovers` (the drained reason line and
 * `completion.leftovers`) and `api/projections.ts:completionPreview` (U-14's prompt) both count these,
 * so the number the Author is told is the number that gets thrown away.
 */
export const DISCARDABLE_IDEA_STATES: Idea['state'][] = ['proposed', 'verified', 'refuted', 'unverifiable'];

export { renderPairs };
